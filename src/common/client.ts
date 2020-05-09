import Messaging from './messaging';
import { QueueItem, PlayableMedia, PlayableSource } from '../server/playback';
import { EventEmitter } from 'events';
import { YoutubeVideo } from '../server/youtube';
import { objEqual, specifically } from './utility';
import { ZoneState, UserState } from './zone';

export type StatusMesage = { text: string };
export type JoinMessage = { name: string; token?: string; password?: string };
export type AssignMessage = { userId: string; token: string };
export type RejectMessage = { text: string };
export type UsersMessage = { users: UserState[] };
export type NameMessage = { userId: string; name: string };
export type LeaveMessage = { userId: string };
export type PlayMessage = { item: QueueItem; time: number };
export type QueueMessage = { items: QueueItem[] };
export type SearchMessage = { query: string };

export type SendChat = { text: string };
export type RecvChat = { text: string; userId: string };

export type MoveMessage = { position: number[] };
export type UserMovedMessage = MoveMessage & { userId: string };

export type EmotesMessage = { emotes: string[] };
export type AvatarMessage = { data: string };

export type SearchResult = { results: YoutubeVideo[] };

function isYoutube(item: PlayableMedia): item is YoutubeVideo {
    return item.source.type === 'youtube';
}

function mediaEquals(a: PlayableMedia, b: PlayableMedia) {
    return objEqual(a.source, b.source);
}

export interface MessageMap {
    heartbeat: {};
    assign: AssignMessage;
    reject: RejectMessage;
    users: UsersMessage;
    leave: LeaveMessage;
    play: PlayMessage;
    queue: QueueMessage;
    search: SearchMessage;

    chat: SendChat;
    name: NameMessage;
    move: MoveMessage;
    emotes: EmotesMessage;
    avatar: AvatarMessage;
}

export interface ClientOptions {
    quickResponseTimeout: number;
    slowResponseTimeout: number;
    joinName?: string;
}

export const DEFAULT_OPTIONS: ClientOptions = {
    quickResponseTimeout: 1000,
    slowResponseTimeout: 5000,
};

export interface ClientEventMap {
    disconnect: (event: { clean: boolean }) => void;

    chat: (event: { user: UserState; text: string; local: boolean }) => void;
    join: (event: { user: UserState }) => void;
    leave: (event: { user: UserState }) => void;
    rename: (event: { user: UserState; previous: string; local: boolean }) => void;
    status: (event: { text: string }) => void;

    play: (event: { message: PlayMessage }) => void;
    queue: (event: { item: QueueItem }) => void;
}

export interface ZoneClient {
    on<K extends keyof ClientEventMap>(event: K, callback: ClientEventMap[K]): this;
    off<K extends keyof ClientEventMap>(event: K, callback: ClientEventMap[K]): this;
    once<K extends keyof ClientEventMap>(event: K, callback: ClientEventMap[K]): this;
    emit<K extends keyof ClientEventMap>(event: K, ...args: Parameters<ClientEventMap[K]>): boolean;
}

export class ZoneClient extends EventEmitter {
    readonly options: ClientOptions;
    readonly messaging = new Messaging();
    readonly zone = new ZoneState();

    private assignation?: AssignMessage;

    constructor(options: Partial<ClientOptions> = {}) {
        super();
        this.options = Object.assign({}, DEFAULT_OPTIONS, options);
        this.addStandardListeners();
    }

    get localUserId() {
        return this.assignation?.userId;
    }

    clear() {
        this.zone.clear();
    }

    async rename(name: string): Promise<NameMessage> {
        return new Promise((resolve, reject) => {
            setTimeout(() => reject('timeout'), this.options.quickResponseTimeout);
            specifically(
                this.messaging.messages,
                'name',
                (message: NameMessage) => message.userId === this.localUserId,
                resolve,
            );
            this.messaging.send('name', { name });
        });
    }

    async expect<K extends keyof MessageMap>(type: K, timeout?: number): Promise<MessageMap[K]> {
        return new Promise((resolve, reject) => {
            if (timeout) setTimeout(() => reject('timeout'), timeout);
            this.messaging.messages.once(type, (message) => resolve(message));
        });
    }

    async join(options: { name?: string; token?: string; password?: string } = {}) {
        this.clear();
        options.name = options.name || this.options.joinName || 'anonymous';
        options.token = options.token || this.assignation?.token;

        return new Promise<AssignMessage>((resolve, reject) => {
            this.expect('assign', this.options.quickResponseTimeout).then(resolve, reject);
            this.expect('reject').then(reject);
            this.messaging.send('join', options);
        }).then((assign) => {
            this.assignation = assign;
            return assign;
        });
    }

    async rejoin(password?: string) {
        if (!this.assignation) return this.join({ password });

        const user = this.zone.getUser(this.assignation.userId);
        this.clear();

        await this.join({ name: user.name, token: this.assignation.token, password });

        if (user.position) this.messaging.send('move', { position: user.position });
        if (user.avatar) this.messaging.send('avatar', { data: user.avatar });
        this.messaging.send('emotes', { emotes: user.emotes });

        return this.assignation;
    }

    async heartbeat() {
        return new Promise<{}>((resolve, reject) => {
            this.expect('heartbeat', this.options.quickResponseTimeout).then(resolve, reject);
            this.messaging.send('heartbeat', {});
        });
    }

    async resync() {
        return new Promise<PlayMessage>((resolve, reject) => {
            this.expect('play', this.options.quickResponseTimeout).then(resolve, reject);
            this.messaging.send('resync');
        });
    }

    async chat(text: string) {
        this.messaging.send('chat', { text });
    }

    async search(query: string) {
        return new Promise<SearchResult>((resolve, reject) => {
            this.expect('search', this.options.slowResponseTimeout).then(resolve as any, reject);
            this.messaging.send('search', { query });
        });
    }

    async lucky(query: string) {
        return new Promise<QueueMessage>((resolve, reject) => {
            this.expect('queue', this.options.slowResponseTimeout).then(resolve, reject);
            this.messaging.send('search', { query, lucky: true });
        });
    }

    async youtube(videoId: string) {
        return new Promise<QueueItem>((resolve, reject) => {
            setTimeout(() => reject('timeout'), this.options.slowResponseTimeout);
            this.on('queue', ({ item }) => {
                if (isYoutube(item.media) && item.media.source.videoId === videoId) resolve(item);
            });
            this.messaging.send('youtube', { videoId });
        });
    }

    async skip(password?: string) {
        if (!this.zone.lastPlayedItem) return;

        this.messaging.send('skip', {
            password,
            source: this.zone.lastPlayedItem.media.source,
        });
    }

    async unplayable(source?: PlayableSource) {
        source = source || this.zone.lastPlayedItem?.media.source;
        if (!source) return;
        this.messaging.send('error', { source });
    }

    private addStandardListeners() {
        this.messaging.on('close', (code) => {
            const clean = code <= 1001;
            this.emit('disconnect', { clean });
        });
        this.messaging.messages.on('status', (message: StatusMesage) => {
            this.emit('status', { text: message.text });
        });
        this.messaging.messages.on('name', (message: NameMessage) => {
            const user = this.zone.getUser(message.userId);
            const local = user.userId === this.localUserId;
            const previous = user.name;
            user.name = message.name;

            if (previous) this.emit('rename', { user, previous, local });
            else this.emit('join', { user });
        });
        this.messaging.messages.on('leave', (message: LeaveMessage) => {
            const user = this.zone.getUser(message.userId);
            this.zone.users.delete(message.userId);
            this.emit('leave', { user });
        });
        this.messaging.messages.on('users', (message: UsersMessage) => {
            this.zone.users.clear();
            message.users.forEach((user: UserState) => {
                this.zone.users.set(user.userId, user);
            });
        });
        this.messaging.messages.on('chat', (message: RecvChat) => {
            const user = this.zone.getUser(message.userId);
            const local = user.userId === this.localUserId;
            this.emit('chat', { user, text: message.text, local });
        });
        this.messaging.messages.on('play', (message: PlayMessage) => {
            this.zone.lastPlayedItem = message.item;

            const index = this.zone.queue.findIndex((item) => mediaEquals(item.media, message.item.media));
            if (index >= 0) this.zone.queue.splice(index, 1);

            this.emit('play', { message });
        });
        this.messaging.messages.on('queue', (message: QueueMessage) => {
            if (message.items.length === 1) this.emit('queue', { item: message.items[0] });
            this.zone.queue.push(...message.items);
        });
        this.messaging.messages.on('move', (message: UserMovedMessage) => {
            const user = this.zone.getUser(message.userId);

            if (user.userId !== this.localUserId || !user.position) {
                user.position = message.position;
            }
        });
        this.messaging.messages.on('emotes', (message) => {
            this.zone.getUser(message.userId).emotes = message.emotes;
        });
    }
}

export default ZoneClient;
