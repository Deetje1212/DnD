/**
 * MultiplayerManager — WebRTC (PeerJS) sync via a star topology: every
 * player connects to the host, and the host relays messages to
 * everyone. This avoids duplicate AI calls (only the host talks to the
 * AI DM) and keeps the game state consistent.
 *
 * Room code = the host's PeerJS peer ID (shortened and made readable),
 * free via the public PeerJS signaling server — no backend of our own
 * needed, so it's a perfect fit for Netlify static hosting.
 */
class MultiplayerManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomCode = null;
    this.myId = null;         // our own player uuid (separate from the peer id)
    this.myName = null;
    this.conns = new Map();   // host: peerId -> DataConnection
    this.hostConn = null;     // peer (non-host): connection to the host
    this.handlers = {};       // event type -> [callbacks]
    this.connectedPlayerIds = new Set();
  }

  on(type, cb) {
    (this.handlers[type] = this.handlers[type] || []).push(cb);
  }

  _emit(type, payload, fromId) {
    (this.handlers[type] || []).forEach(cb => cb(payload, fromId));
  }

  _randomRoomCode() {
    const words = ['dragon', 'runes', 'shade', 'guild', 'rogue', 'crypt', 'curse', 'ashfall'];
    const w = words[Math.floor(Math.random() * words.length)];
    return `dnd-${w}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  /** Starts as host: creates a room, returns a Promise<roomCode>. */
  hostRoom(playerName) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.myId = genUUID();
      this.myName = playerName;
      this.roomCode = this._randomRoomCode();

      this.peer = new Peer(this.roomCode);
      this.peer.on('open', () => resolve(this.roomCode));
      this.peer.on('error', (err) => reject(err));

      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.conns.set(conn.peer, conn);
        });
        conn.on('data', (msg) => this._handleIncoming(msg, conn));
        conn.on('close', () => {
          this.conns.delete(conn.peer);
          this._emit('peer_disconnected', { peerId: conn.peer });
        });
      });
    });
  }

  /** Joins an existing room via the room code (= the host's peer id). */
  joinRoom(roomCode, playerName) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      this.myId = genUUID();
      this.myName = playerName;
      this.roomCode = roomCode.trim().toLowerCase();

      this.peer = new Peer();
      this.peer.on('error', (err) => reject(err));
      this.peer.on('open', () => {
        const conn = this.peer.connect(this.roomCode, { reliable: true });
        conn.on('open', () => {
          this.hostConn = conn;
          this.send('hello', { playerId: this.myId, name: this.myName });
          resolve();
        });
        conn.on('data', (msg) => this._handleIncoming(msg, conn));
        conn.on('error', (err) => reject(err));
      });
    });
  }

  _handleIncoming(msg, conn) {
    if (!msg || !msg.type) return;

    if (this.isHost) {
      // Make sure the connection is linked to the player uuid from the message
      if (msg.type === 'hello') {
        this.connectedPlayerIds.add(msg.payload.playerId);
      }
      this._emit(msg.type, msg.payload, msg.senderId);

      // The host automatically relays these message types to all OTHER
      // peers (the sender already applied the change locally and
      // optimistically, and the host already applies it above via _emit).
      // 'action' and 'char_request' are excluded: those first require an
      // AI call by the host, after which the host itself broadcasts a
      // new message (dm_response / character_created).
      const relayDirect = ['roll', 'loot_response', 'inventory_update'];
      if (relayDirect.includes(msg.type)) {
        this.broadcast(msg.type, msg.payload, msg.senderId, /* excludeSender */ conn.peer);
      }
    } else {
      // As a peer we only receive from the host — relay 1-to-1 to our handlers
      this._emit(msg.type, msg.payload, msg.senderId);
    }
  }

  /**
   * Sends a message to the host (only meaningful if you're a peer yourself).
   * Applies NOTHING locally — the calling code is responsible for its own
   * optimistic local update (see main.js: dispatch()).
   */
  send(type, payload) {
    if (this.isHost || !this.hostConn) return;
    this.hostConn.send({ type, payload, senderId: this.myId });
  }

  /**
   * Host only: send to all connected peers (optionally excluding one,
   * e.g. the original sender who already applied it locally). Applies
   * NOTHING locally on the host itself.
   */
  broadcast(type, payload, senderId = this.myId, excludePeerId = null) {
    if (!this.isHost) return;
    const envelope = { type, payload, senderId };
    this.conns.forEach((conn, peerId) => {
      if (peerId !== excludePeerId) conn.send(envelope);
    });
  }

  isSolo() {
    return this.peer === null;
  }
}

window.multiplayer = new MultiplayerManager();