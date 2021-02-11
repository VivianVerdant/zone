import * as WebSocket from 'ws';
import * as expressWs from 'express-ws';
import * as low from 'lowdb';

import Playback from './playback';
import Messaging from '../common/messaging';
import { ZoneState, UserId, UserState, mediaEquals, Media, QueueItem, UserEcho } from '../common/zone';
import { nanoid } from 'nanoid';
import { getDefault, randomInt } from '../common/utility';
import { MESSAGE_SCHEMAS } from './protocol';
import { JoinMessage, SendAuth, SendCommand, EchoMessage } from '../common/client';
import fetch from 'node-fetch';
import { json, NextFunction, Request, Response } from 'express';

const SECONDS = 1000;

declare global {
    namespace Express {
        interface Request {
            user?: UserState;
        }
    }
}

export type HostOptions = {
    pingInterval: number;
    saveInterval: number;
    userTimeout: number;
    nameLengthLimit: number;
    chatLengthLimit: number;

    perUserQueueLimit: number;
    voteSkipThreshold: number;
    errorSkipThreshold: number;

    joinPassword?: string;
    authPassword?: string;

    playbackStartDelay: number;
    libraryOrigin?: string;
    youtubeOrigin?: string;
    youtubePassword?: string;
};

export const DEFAULT_OPTIONS: HostOptions = {
    pingInterval: 10 * SECONDS,
    saveInterval: 60 * SECONDS,
    userTimeout: 5 * SECONDS,
    nameLengthLimit: 16,
    chatLengthLimit: 160,

    perUserQueueLimit: 3,
    voteSkipThreshold: 0.6,
    errorSkipThreshold: 0.4,

    playbackStartDelay: 1 * SECONDS,
};

const bans = new Map<unknown, Ban>();

const ipToNetworkId = new Map<unknown, string>();
const networkIdToIp = new Map<string, unknown>();

function getNetworkIdFromIp(ip: unknown) {
    const networkId = getDefault(ipToNetworkId, ip, () => ipToNetworkId.size.toString());
    networkIdToIp.set(networkId, ip);
    return networkId;
}

interface Ban {
    ip: unknown;
    bannee: string;
    banner: string;
    reason?: string;
    date: string;
}

export function host(
    xws: expressWs.Instance,
    adapter: low.AdapterSync,
    options: Partial<HostOptions> = {},
) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    const db = low(adapter);
    db.defaults({
        playback: { current: undefined, queue: [], time: 0 },
        bans: [],
        echoes: [],
    }).write();

    // this zone's websocket endpoint
    xws.app.ws('/zone', (websocket, req) => waitJoin(websocket, req.ip));

    xws.app.get('/users', (req, res) => {
        const users = Array.from(zone.users.values());
        const names = users.map(({ name, avatar, userId }) => ({ name, avatar, userId }));
        res.json(names);
    });

    function ping() {
        xws.getWss().clients.forEach((websocket) => {
            try {
                websocket.ping();
            } catch (e) {
                console.log("couldn't ping", e);
            }
        });
    }

    setInterval(ping, opts.pingInterval);
    // setInterval(save, opts.saveInterval);

    function addUserToken(user: UserState, token: string) {
        tokenToUser.set(token, user);
        userToToken.set(user, token);
    }

    function revokeUserToken(user: UserState) {
        const token = userToToken.get(user);
        if (token) tokenToUser.delete(token);
        userToToken.delete(user);
    }

    let lastUserId = 0;
    const tokenToUser = new Map<string, UserState>();
    const userToToken = new Map<UserState, string>();
    const userToIp = new Map<UserState, unknown>();
    const connections = new Map<UserId, Messaging>();

    const zone = new ZoneState();
    const playback = new Playback(opts.playbackStartDelay);

    let eventMode = false;

    function requireUserToken(
        request: Request, 
        response: Response, 
        next: NextFunction,
    ) {
        const auth = request.headers.authorization || "";
        const token = auth.startsWith("Bearer ") ? auth.substr(7) : "";
        request.user = tokenToUser.get(token);

        if (request.user) {
            next();
        } else {
            response.status(401).json({ title: "Invalid user." });
        }
    }

    xws.app.use(json());
    xws.app.post('/queue', requireUserToken, async (request, response) => {
        status("you tested the command", request.user!);
        response.status(202).send();

        const user = request.user!;
        const path = request.body.path;

        if (path.startsWith("library:") && options.libraryOrigin) {
            const id = path.substr(8);
            const media = await libraryToMedia(id);
            if (media) tryQueueMedia(user, media);
        } else if (path.startsWith("youtube:") && options.youtubeOrigin) {
            const youtubeId = path.substr(8);
            const media = await youtubeToMedia(youtubeId);
            if (media) tryQueueMedia(user, media);
        }
    });

    xws.app.post('/queue/banger', requireUserToken, async (request, response) => {
        if (!options.libraryOrigin) return;
        const tag = request.body.tag;
        const url = options.libraryOrigin + "/library";
        const query = tag ? "?tag=" + tag : "";

        response.status(202).send();

        const EIGHT_MINUTES = 8 * 60 * SECONDS;
        const library = await (await fetch(url + query)).json();
        const extras = library.filter((media: any) => media.duration <= EIGHT_MINUTES);
        const banger = extras[randomInt(0, extras.length - 1)];
        if (banger) tryQueueMedia(request.user!, banger, true);
    });

    xws.app.post('/queue/skip', requireUserToken, async (request, response) => {
        const user = request.user!;
        const source = request.body.source;
        
        if (!playback.currentItem || playback.currentItem.media.source !== source) return;

        if (!eventMode) {
            voteSkip(source, user);
        } else if (user.tags.includes('dj')) {
            skip(`${user.name} skipped ${playback.currentItem!.media.title}`);
        } else {
            status(`can't skip during event mode`, user);
        }

        response.status(202).send();
    });

    xws.app.delete('/queue/:itemId', requireUserToken, async (request, response) => {
        const user = request.user!;
        const itemId = request.body.itemId;

        const item = playback.queue.find((item) => item.itemId === itemId);
        if (!item) return;

        const dj = eventMode && user.tags.includes('dj');
        const own = item.info.userId === user.userId;
        const auth = user.tags.includes('admin');

        if (dj || own || auth) playback.unqueue(item);

        response.status(202).send();
    });

    load();

    playback.on('queue', (item: QueueItem) => sendAll('queue', { items: [item] }));
    playback.on('play', (item: QueueItem) => sendAll('play', { item, time: playback.currentTime }));
    playback.on('stop', () => sendAll('play', {}));
    playback.on('unqueue', ({ itemId }) => sendAll('unqueue', { itemId }));
    playback.on('failed', (item: QueueItem) => skip("video failed to load"));

    const skips = new Set<UserId>();
    playback.on('play', async (item) => skips.clear());

    function load() {
        playback.loadState(db.get('playback').value());

        const banlist = db.get('bans').value() as Ban[];
        banlist.forEach((ban) => bans.set(ban.ip, ban));

        zone.echoes.clear();
        const echoes = db.get('echoes').value() as UserEcho[];
        echoes.forEach((echo) => zone.echoes.set(echo.position!, echo));
    }

    function save() {
        db.set('playback', playback.copyState()).write();
        db.set('bans', Array.from(bans.values())).write();
        db.set(
            'echoes',
            Array.from(zone.echoes).map(([, echo]) => echo),
        ).write();
    }

    const userToConnections = new Map<UserState, Set<Messaging>>();
    function addConnectionToUser(user: UserState, messaging: Messaging) {
        const connections = userToConnections.get(user) || new Set<Messaging>();
        connections.add(messaging);
        userToConnections.set(user, connections);
    }

    function removeConnectionFromUser(user: UserState, messaging: Messaging) {
        userToConnections.get(user)?.delete(messaging);
    }

    function isUserConnectionless(user: UserState) {
        const connections = userToConnections.get(user);
        const connectionless = !connections || connections.size === 0;
        return connectionless;
    }

    function killUser(user: UserState) {
        if (zone.users.has(user.userId)) sendAll('leave', { userId: user.userId });
        zone.users.delete(user.userId);
        connections.delete(user.userId);
        userToConnections.delete(user);
        revokeUserToken(user);
    }

    function voteSkip(source: string, user: UserState) {
        if (!playback.currentItem || playback.currentItem.media.source !== source) return;

        skips.add(user.userId);
        const current = skips.size;
        const target = Math.ceil(zone.users.size * opts.voteSkipThreshold);
        if (current >= target) {
            skip(`voted to skip ${playback.currentItem.media.title}`);
        } else {
            status(`${current} of ${target} votes to skip`);
        }
    }

    function skip(message?: string) {
        if (message) status(message);
        playback.skip();
    }

    function waitJoin(websocket: WebSocket, userIp: unknown) {
        const messaging = new Messaging();
        messaging.setSocket(websocket);
        messaging.on('error', () => {});

        if (bans.has(userIp)) {
            messaging.send('reject', { text: 'you are banned' });
            websocket.close(4001, 'banned');
            return;
        }

        messaging.messages.once('join', (message: JoinMessage) => {
            const resume = message.token && tokenToUser.has(message.token);
            const authorised = resume || !opts.joinPassword || message.password === opts.joinPassword;

            if (!authorised) {
                messaging.send('reject', { text: 'rejected: password required' });
                websocket.close(4000);
                return;
            }

            const token = resume ? message.token! : nanoid();
            const user = resume ? tokenToUser.get(token)! : zone.getUser((++lastUserId).toString() as UserId);
            user.name = message.name;

            addUserToken(user, token);
            addConnectionToUser(user, messaging);
            userToIp.set(user, userIp);

            bindMessagingToUser(user, messaging, getNetworkIdFromIp(userIp));
            connections.set(user.userId, messaging);

            websocket.on('close', (code: number) => {
                removeConnectionFromUser(user, messaging);
                const cleanExit = code === 1000 || code === 1001;

                if (cleanExit) {
                    killUser(user);
                } else {
                    setTimeout(() => {
                        if (isUserConnectionless(user)) killUser(user);
                    }, opts.userTimeout);
                }
            });

            sendCoreState(user);
            sendOnly('assign', { userId: user.userId, token }, user.userId);
            if (!resume) sendAll('user', user);
            sendOtherState(user);
        });
    }

    function sendCurrent(user: UserState) {
        if (playback.currentItem) {
            sendOnly('play', { item: playback.currentItem, time: playback.currentTime }, user.userId);
        } else {
            sendOnly('play', {}, user.userId);
        }
    }

    function sendCoreState(user: UserState) {
        const users = Array.from(zone.users.values());
        sendOnly('users', { users }, user.userId);
        sendOnly('queue', { items: playback.queue }, user.userId);
        sendCurrent(user);
    }

    function sendOtherState(user: UserState) {
        sendOnly('echoes', { added: Array.from(zone.echoes).map(([, echo]) => echo) }, user.userId);
    }

    function ifUser(name: string, action: (user: UserState) => void) {
        const user = userByName(name);
        if (user) action(user);
    }

    function userByName(name: string) {
        return Array.from(zone.users.values()).find((user) => user.name === name);
    }

    function status(text: string, user?: UserState) {
        if (user) sendOnly('status', { text }, user.userId);
        else sendAll('status', { text });
    }

    function statusAuthed(text: string) {
        zone.users.forEach((user) => {
            if (user.tags.includes('admin')) status(text, user);
        });
    }

    const authCommands = new Map<string, (admin: UserState, ...args: any[]) => void>();
    authCommands.set('ban', (admin, name: string, reason?: string) => {
        ifUser(name, (user) => {
            const ban: Ban = {
                ip: userToIp.get(user)!,
                bannee: user.name!,
                banner: admin.name!,
                reason,
                date: JSON.stringify(new Date()),
            };
            bans.set(ban.ip, ban);
            status(`${user.name} is banned`);

            (userToConnections.get(user) || new Set<Messaging>()).forEach((messaging) => messaging.close(4001));
        });
    });
    authCommands.set('skip', () => skip(`admin skipped ${playback.currentItem!.media.title}`));
    authCommands.set('mode', (admin, mode: string) => {
        eventMode = mode === 'event';
        status(`event mode: ${eventMode}`);
    });
    authCommands.set('dj-add', (admin, name: string) =>
        ifUser(name, (user) => {
            if (user.tags.includes('dj')) {
                status(`${user.name} is already a dj`, admin);
            } else {
                user.tags.push('dj');
                sendAll('user', { userId: user.userId, tags: user.tags });
                status('you are a dj', user);
                statusAuthed(`${user.name} is a dj`);
            }
        }),
    );
    authCommands.set('dj-del', (admin, name: string) =>
        ifUser(name, (user) => {
            if (!user.tags.includes('dj')) {
                status(`${user.name} isn't a dj`, admin);
            } else {
                user.tags.splice(user.tags.indexOf('dj'), 1);
                sendAll('user', { userId: user.userId, tags: user.tags });
                status('no longer a dj', user);
                statusAuthed(`${user.name} no longer a dj`);
            }
        }),
    );
    authCommands.set('despawn', (admin, name: string) => 
        ifUser(name, (user) => {
            if (!user.position) {
                status(`${user.name} isn't spawned`, admin);
            } else {
                user.position = undefined;
                sendAll('user', { userId: user.userId, position: null });
                status('you were despawned by an admin', user);
                statusAuthed(`${user.name} has been despawned`);
            }
        }),
    );

    function tryQueueMedia(user: UserState, media: Media, banger = false) {
        if (eventMode && !user.tags.includes('dj')) {
            status('zone is currently in event mode, only djs may queue', user);
            return;
        }

        const userIp = userToIp.get(user);
        const existing = playback.queue.find((queued) => mediaEquals(queued.media, media))?.media;
        const count = playback.queue.filter((item) => item.info.ip === userIp).length;
        const dj = eventMode && user.tags.includes('dj');

        if (existing) {
            status(`'${existing.title}' is already queued`, user);
        } else if (!dj && count >= opts.perUserQueueLimit) {
            status(`you already have ${count} videos in the queue`, user);
        } else {
            playback.queueMedia(media, { userId: user.userId, ip: userIp, banger });
        }
    }

    async function youtubeToMedia(youtubeId: string) {
        const media = await fetch(`${options.youtubeOrigin}/youtube/${youtubeId}/info`).then(r => r.json());
        await fetch(
            `${options.youtubeOrigin}/youtube/${youtubeId}/request`,
            { 
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + options.youtubePassword,
                }
            }
        );
        media.getStatus = async () => fetch(`${options.youtubeOrigin}/youtube/${youtubeId}/status`).then(r => r.json());
        return media;
    }

    async function libraryToMedia(libraryId: string) {
        const media = await fetch(options.libraryOrigin + "/library/" + libraryId).then(r => r.json());
        return media;
    }

    function bindMessagingToUser(user: UserState, messaging: Messaging, userIp: unknown) {
        function sendUser(type: string, message: any = {}) {
            sendOnly(type, message, user.userId);
        }

        messaging.messages.on('heartbeat', () => sendUser('heartbeat'));

        messaging.messages.on('chat', (message: any) => {
            let { text } = message;
            text = text.substring(0, opts.chatLengthLimit);
            sendAll('chat', { text, userId: user.userId });
        });

        messaging.messages.on('user', (changes: Partial<UserState>) => {
            const { value, error } = MESSAGE_SCHEMAS.get('user')!.validate(changes);

            if (error) {
                sendUser('reject', { text: error.details[0].message });
            } else {
                Object.assign(user, value);
                sendAll('user', { ...value, userId: user.userId });
            }
        });

        messaging.messages.on('auth', (message: SendAuth) => {
            if ((message.password || {}) !== opts.authPassword) return;

            if (user.tags.includes('admin')) {
                status('you are already authorised', user);
            } else {
                user.tags.push('admin');
                sendAll('user', { userId: user.userId, tags: user.tags });
                status('you are now authorised', user);
            }
        });

        messaging.messages.on('command', (message: SendCommand) => {
            if (!user.tags.includes('admin')) return;

            const { name, args } = message;
            const command = authCommands.get(name);
            if (command) {
                command(user, ...args);
            } else {
                status(`no command "${name}"`, user);
            }
        });

        messaging.messages.on('echo', (message: EchoMessage) => {
            const { text, position } = message;

            const admin = !!zone.echoes.get(position)?.tags.includes('admin');
            const valid = !admin || user.tags.includes('admin');

            if (!valid) {
                status("can't remove admin echo", user);
            } else if (text.length > 0) {
                const echo = { ...user, position, text: text.slice(0, 512) };
                zone.echoes.set(position, echo);
                sendAll('echoes', { added: [echo] });
            } else {
                zone.echoes.delete(position);
                sendAll('echoes', { removed: [position] });
            }
        });
    }

    function sendAll(type: string, message: any) {
        connections.forEach((connection) => connection.send(type, message));
    }

    function sendOnly(type: string, message: any, userId: UserId) {
        connections.get(userId)!.send(type, message);
    }

    return { zone, playback, save, sendAll, authCommands };
}
