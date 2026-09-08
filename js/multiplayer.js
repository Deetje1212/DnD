/**
 * MultiplayerManager — WebRTC (PeerJS) sync via een ster-topologie:
 * elke speler verbindt met de host, de host relayt berichten naar
 * iedereen. Dit voorkomt dubbele AI-aanroepen (alleen de host praat
 * met de AI DM) en houdt de game-state consistent.
 *
 * Roomcode = het PeerJS peer-ID van de host (verkort en leesbaar
 * gemaakt), gratis via de openbare PeerJS signaling server — geen
 * eigen backend nodig, dus perfect voor Netlify static hosting.
 */
class MultiplayerManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomCode = null;
    this.myId = null;         // ons eigen speler-uuid (los van peer-id)
    this.myName = null;
    this.conns = new Map();   // host: peerId -> DataConnection
    this.hostConn = null;     // peer (non-host): connectie naar host
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
    const words = ['drakon', 'runen', 'schim', 'gilde', 'zwerf', 'krypt', 'vloek', 'aslot'];
    const w = words[Math.floor(Math.random() * words.length)];
    return `dnd-${w}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  /** Start als host: maakt kamer aan, retourneert een Promise<roomCode>. */
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

  /** Join een bestaande kamer via de roomcode (= host's peer-id). */
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
      // Zorg dat de connectie gekoppeld is aan de speler-uuid uit het bericht
      if (msg.type === 'hello') {
        this.connectedPlayerIds.add(msg.payload.playerId);
      }
      this._emit(msg.type, msg.payload, msg.senderId);

      // Host relayt deze berichttypes automatisch door naar alle ANDERE
      // peers (de afzender heeft de wijziging zelf al optimistisch
      // lokaal toegepast, en de host past 'm hierboven al toe via _emit).
      // 'action' en 'char_request' zijn uitgesloten: die vereisen eerst
      // een AI-aanroep door de host, waarna de host zelf een nieuw
      // bericht (dm_response / character_created) uitzendt.
      const relayDirect = ['roll', 'loot_response', 'inventory_update'];
      if (relayDirect.includes(msg.type)) {
        this.broadcast(msg.type, msg.payload, msg.senderId, /* excludeSender */ conn.peer);
      }
    } else {
      // Als peer ontvangen we alleen van de host — relay 1-op-1 naar onze handlers
      this._emit(msg.type, msg.payload, msg.senderId);
    }
  }

  /**
   * Stuur een bericht naar de host (alleen zinvol als je zelf een peer bent).
   * Past NIETS lokaal toe — de aanroepende code is verantwoordelijk voor de
   * eigen optimistische lokale update (zie main.js: dispatch()).
   */
  send(type, payload) {
    if (this.isHost || !this.hostConn) return;
    this.hostConn.send({ type, payload, senderId: this.myId });
  }

  /**
   * Alleen host: stuur naar alle verbonden peers (optioneel er één
   * uitsluiten, bv. de oorspronkelijke afzender die het al lokaal heeft
   * toegepast). Past NIETS lokaal toe bij de host zelf.
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