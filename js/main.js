/**
 * main.js — application state + wiring. Contains the "dispatch" layer
 * that makes sure every action is applied optimistically locally first,
 * and then (where applicable) shared over the network — without being
 * applied twice for the sender itself.
 */
const App = {
  state: {
    players: {},   // id -> {id, name, character}
    history: []    // log entries: {type, text, player?}
  },
  myId: null,
  myName: 'Player',
  soloMode: false,
  started: false,
  busy: false // true while waiting on an AI response
};

// ============================================================
// Dispatch layer
// ============================================================
function dispatch(type, payload, applyFn) {
  applyFn(payload, App.myId); // optimistic local application
  if (App.soloMode) return;
  if (window.multiplayer.isHost) {
    window.multiplayer.broadcast(type, payload, App.myId);
  } else {
    window.multiplayer.send(type, payload);
  }
}

function addHistory(entry) {
  App.state.history.push(entry);
  UI.appendLog(entry);
}

// ============================================================
// Handlers (shared between local dispatch and incoming network events)
// ============================================================
function applyRoll(payload) {
  addHistory({ type: 'roll', player: payload.playerName, text: payload.label });
}

function applyCharacterCreated(payload) {
  const existing = App.state.players[payload.playerId] || { id: payload.playerId };
  App.state.players[payload.playerId] = { ...existing, name: payload.name, character: payload.character };
  refreshLobbyOrGameUI();
}

function applyLootResponse(payload) {
  if (!payload.accept) {
    addHistory({ type: 'system', text: `${payload.playerName} leaves ${payload.item.name} behind.` });
    return;
  }
  const p = App.state.players[payload.playerId];
  if (p && p.character) {
    p.character = CharacterFactory.addItem(p.character, payload.item);
    addHistory({ type: 'system', text: `${payload.playerName} picks up ${payload.item.name}.` });
    refreshLobbyOrGameUI();
  }
}

function applyInventoryUpdate(payload) {
  const p = App.state.players[payload.playerId];
  if (!p || !p.character) return;
  if (payload.action === 'add') {
    p.character = CharacterFactory.addItem(p.character, { name: payload.itemName, description: '' });
  } else if (payload.action === 'remove') {
    p.character = CharacterFactory.removeItem(p.character, payload.itemName);
  }
  refreshLobbyOrGameUI();
}

/** Only ever received (never dispatched locally) — the host is the only one who generates this. */
function applyDmResponse(payload) {
  addHistory({ type: 'narrative', text: payload.narrative });

  (payload.levelup || []).forEach(lu => {
    const target = findPlayerByName(lu.player);
    if (target && target.character) {
      target.character = CharacterFactory.applyLevelUp(target.character, lu);
      addHistory({ type: 'system', text: `${target.name} reaches level ${target.character.level}!` });
      UI.toast(`${target.name} levels up to ${target.character.level}!`);
    }
  });

  (payload.hpChanges || []).forEach(hc => {
    const target = findPlayerByName(hc.player);
    if (!target || !target.character) return;
    const amount = Number(hc.amount || 0);
    if (!amount) return;
    const wasDead = CharacterFactory.isDead(target.character);
    target.character = CharacterFactory.applyDamageOrHeal(target.character, amount);
    const verb = amount < 0 ? 'takes' : 'heals';
    const amountLabel = amount < 0 ? `${Math.abs(amount)} damage` : `${amount} HP`;
    const reason = hc.reason ? ` (${hc.reason})` : '';
    addHistory({ type: 'system', text: `${target.name} ${verb} ${amountLabel}${reason}. HP: ${target.character.hp.current}/${target.character.hp.max}` });

    const nowDead = CharacterFactory.isDead(target.character);
    if (nowDead && !wasDead) {
      addHistory({ type: 'system', text: `☠ ${target.name} has died.` });
      UI.toast(`☠ ${target.name} has died.`);
      if (target.id === App.myId) setActionInputEnabled(false);
    } else if (!nowDead && wasDead) {
      addHistory({ type: 'system', text: `✚ ${target.name} is revived!` });
      UI.toast(`✚ ${target.name} is revived!`);
      if (target.id === App.myId && !App.busy) setActionInputEnabled(true);
    }
  });

  (payload.loot || []).forEach(loot => {
    const target = findPlayerByName(loot.player);
    if (!target) return;
    if (target.id === App.myId) {
      UI.showLootModal(loot,
        () => dispatch('loot_response',
          { playerId: App.myId, playerName: App.myName, accept: true, item: { name: loot.item, description: loot.description } },
          applyLootResponse),
        () => dispatch('loot_response',
          { playerId: App.myId, playerName: App.myName, accept: false, item: { name: loot.item, description: loot.description } },
          applyLootResponse)
      );
    }
  });

  refreshLobbyOrGameUI();
  App.busy = false;
  const me = App.state.players[App.myId];
  setActionInputEnabled(!me?.character || !CharacterFactory.isDead(me.character));
}

function findPlayerByName(playerName) {
  return Object.values(App.state.players).find(p => p.name === playerName);
}

// ============================================================
// Network event registration
// ============================================================
function wireMultiplayerEvents() {
  const mp = window.multiplayer;

  mp.on('hello', (payload) => {
    // only the host receives this
    App.state.players[payload.playerId] = { id: payload.playerId, name: payload.name, character: null };
    mp.broadcast('state_sync', { players: App.state.players, history: App.state.history }, App.myId);
    refreshLobbyOrGameUI();
  });

  mp.on('state_sync', (payload) => {
    App.state.players = payload.players;
    App.state.history = payload.history;
    UI.renderFullLog(App.state.history);
    refreshLobbyOrGameUI();
  });

  mp.on('roll', (payload) => applyRoll(payload));
  mp.on('character_created', (payload) => applyCharacterCreated(payload));
  mp.on('loot_response', (payload) => applyLootResponse(payload));
  mp.on('inventory_update', (payload) => applyInventoryUpdate(payload));
  mp.on('dm_response', (payload) => applyDmResponse(payload));

  mp.on('action', async (payload, fromId) => {
    // Only the host processes this: calls the AI and broadcasts the result.
    if (!mp.isHost) return;
    addHistory({ type: 'action', player: payload.playerName, text: payload.text });
    mp.broadcast('action_echo', payload, fromId);
    await runDmTurn(payload.playerName, payload.text);
  });
  mp.on('action_echo', (payload, fromId) => {
    if (fromId === App.myId) return; // own action already shown locally
    addHistory({ type: 'action', player: payload.playerName, text: payload.text });
  });

  mp.on('peer_disconnected', () => refreshLobbyOrGameUI());
}

// ============================================================
// AI calls (only host / solo performs these)
// ============================================================
async function runDmTurn(actingPlayerName, actionText) {
  try {
    const result = await DungeonMaster.continueStory(App.state.players, App.state.history, actingPlayerName, actionText);
    if (App.soloMode) {
      applyDmResponse(result);
    } else {
      window.multiplayer.broadcast('dm_response', result, App.myId);
      applyDmResponse(result); // host also applies it locally
    }
  } catch (err) {
    console.error(err);
    addHistory({ type: 'system', text: `⚠ The AI DM could not respond: ${err.message}` });
    App.busy = false;
    setActionInputEnabled(true);
  }
}

// ============================================================
// UI refresh helpers
// ============================================================
let activeSheetId = null;

function refreshLobbyOrGameUI() {
  if (!document.getElementById('screen-lobby').classList.contains('hidden')) {
    UI.renderLobbyPlayerList(App.state.players);
    const allReady = Object.values(App.state.players).length > 0 &&
      Object.values(App.state.players).every(p => p.character);
    const startBtn = document.getElementById('btn-start-adventure');
    if (App.soloMode || window.multiplayer.isHost) {
      startBtn.classList.toggle('hidden', !allReady);
    }
    document.getElementById('lobby-hint').textContent = allReady
      ? (App.soloMode || window.multiplayer.isHost ? 'Everyone is ready — start the adventure!' : 'Waiting for the host to start the adventure...')
      : 'Waiting for everyone to create a character...';
  }
  if (!document.getElementById('screen-game').classList.contains('hidden')) {
    if (!activeSheetId || !App.state.players[activeSheetId]) activeSheetId = App.myId;
    UI.populateActiveSheetSelector(App.state.players, App.myId, (id) => {
      activeSheetId = id;
      UI.renderCharacterSheet(App.state.players[id]?.character);
      wireInventoryButton();
    });
    UI.renderCharacterSheet(App.state.players[activeSheetId]?.character);
    UI.renderPartyStatus(App.state.players);
    wireInventoryButton();
  }
}

function wireInventoryButton() {
  const btn = document.getElementById('btn-open-inventory');
  if (!btn) return;
  btn.onclick = () => refreshInvModal();
}
function refreshInvModal() {
  const me = App.state.players[App.myId];
  if (!me?.character) return;
  UI.renderInventoryModal(me.character,
    (itemName) => { dispatch('inventory_update', { playerId: App.myId, action: 'add', itemName }, applyInventoryUpdate); refreshInvModal(); },
    (itemName) => { dispatch('inventory_update', { playerId: App.myId, action: 'remove', itemName }, applyInventoryUpdate); refreshInvModal(); }
  );
}

function setActionInputEnabled(enabled) {
  document.getElementById('input-action').disabled = !enabled;
  document.getElementById('btn-send-action').disabled = !enabled;
}

function updateAiIndicator() {
  const last = window.aiManager.lastUsed;
  UI.setAiProviderIndicator(last ? `AI: ${last.provider} #${last.index + 1}` : '');
}

// ============================================================
// DOM wiring
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  try {
    wireMultiplayerEvents();
    wireStaticButtons();
    updateKeyStatus();
  } catch (err) {
    // If wiring up the buttons itself already fails, we definitely want
    // to surface that instead of a page that looks alive but where
    // nothing actually works.
    console.error('[App] Could not fully initialize the UI:', err);
    if (window.UI) UI.toast('⚠ The page could not fully load: ' + err.message);
  }
});

// Safety net for truly unexpected errors outside the button handlers
// (e.g. a missing script, a CDN that fails to load) — makes sure that
// becomes visible instead of a page that silently stops doing anything.
window.addEventListener('error', (e) => {
  console.error('[App] Unexpected error:', e.error || e.message);
});

function updateKeyStatus() {
  const el = document.getElementById('ai-key-status');
  el.textContent = window.aiManager.hasAnyKey()
    ? '✓ AI keys set'
    : '⚠ No AI keys set yet — click below';
}

function wireStaticButtons() {
  // --- back buttons ---
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', safeHandler(() => UI.showScreen(btn.dataset.target)));
  });

  // --- settings modal ---
  document.getElementById('btn-settings').addEventListener('click', safeHandler(() => {
    document.getElementById('settings-groq').value = window.aiManager.groqKeys.join('\n');
    document.getElementById('settings-gemini').value = window.aiManager.geminiKeys.join('\n');
    UI.showModal('modal-settings');
  }));
  document.getElementById('btn-settings-cancel').addEventListener('click', safeHandler(() => UI.hideModal('modal-settings')));
  document.getElementById('btn-settings-save').addEventListener('click', safeHandler(() => {
    const groq = document.getElementById('settings-groq').value.split('\n').map(s => s.trim());
    const gemini = document.getElementById('settings-gemini').value.split('\n').map(s => s.trim());
    const persisted = window.aiManager.saveToStorage(groq, gemini);
    updateKeyStatus();
    UI.hideModal('modal-settings');
    UI.toast(persisted
      ? 'AI keys saved (locally in your browser).'
      : 'Keys set for this session — saving locally failed in this browser (e.g. private mode), so you\'ll need to re-enter them after reloading.');
  }));

  // --- solo ---
  document.getElementById('btn-solo').addEventListener('click', safeHandler(() => {
    if (!window.aiManager.hasAnyKey()) {
      UI.toast('Set an AI key first.');
      // Open the settings modal right away so the player doesn't have to
      // hunt for the right button themselves.
      document.getElementById('settings-groq').value = window.aiManager.groqKeys.join('\n');
      document.getElementById('settings-gemini').value = window.aiManager.geminiKeys.join('\n');
      UI.showModal('modal-settings');
      return;
    }
    App.soloMode = true;
    App.myId = genUUID();
    App.state.players = { [App.myId]: { id: App.myId, name: 'Player', character: null } };
    document.getElementById('lobby-room-code').textContent = 'Solo adventure';
    document.getElementById('input-player-name').value = '';
    UI.renderLobbyPlayerList(App.state.players);
    UI.showScreen('screen-lobby');
  }));

  // --- multiplayer choice ---
  document.getElementById('btn-multi').addEventListener('click', safeHandler(() => {
    if (!window.aiManager.hasAnyKey()) { UI.toast('Set an AI key first (only the host needs one).'); }
    UI.showScreen('screen-multi-choice');
  }));

  document.getElementById('btn-create-room').addEventListener('click', safeHandler(async () => {
    const statusEl = document.getElementById('multi-status');
    statusEl.textContent = 'Creating room...';
    try {
      const roomCode = await window.multiplayer.hostRoom('Player');
      App.soloMode = false;
      App.myId = window.multiplayer.myId;
      App.state.players = { [App.myId]: { id: App.myId, name: 'Player', character: null } };
      document.getElementById('lobby-room-code').textContent = `Room code: ${roomCode} — share this with your friends`;
      document.getElementById('input-player-name').value = '';
      UI.renderLobbyPlayerList(App.state.players);
      UI.showScreen('screen-lobby');
    } catch (err) {
      statusEl.textContent = 'Could not create a room: ' + err.message;
    }
  }));

  document.getElementById('btn-join-room').addEventListener('click', safeHandler(async () => {
    const code = document.getElementById('input-room-code').value.trim();
    const statusEl = document.getElementById('multi-status');
    if (!code) { statusEl.textContent = 'Enter a room code.'; return; }
    statusEl.textContent = 'Connecting...';
    try {
      await window.multiplayer.joinRoom(code, 'Player');
      App.soloMode = false;
      App.myId = window.multiplayer.myId;
      App.state.players[App.myId] = { id: App.myId, name: 'Player', character: null };
      document.getElementById('lobby-room-code').textContent = `Room code: ${code}`;
      document.getElementById('input-player-name').value = '';
      UI.renderLobbyPlayerList(App.state.players);
      UI.showScreen('screen-lobby');
    } catch (err) {
      statusEl.textContent = 'Could not connect: ' + err.message;
    }
  }));

  // --- create character ---
  document.getElementById('btn-create-char').addEventListener('click', safeHandler(async () => {
    const name = document.getElementById('input-player-name').value.trim() || 'Player';
    const desc = document.getElementById('input-char-desc').value.trim();
    if (!desc) { UI.toast('Describe your character first.'); return; }
    if (!window.aiManager.hasAnyKey() && (App.soloMode || window.multiplayer.isHost)) {
      UI.toast('Set an AI key first.'); return;
    }
    const btn = document.getElementById('btn-create-char');
    btn.disabled = true;
    btn.textContent = 'Forging character...';
    try {
      App.myName = name;
      if (App.soloMode || window.multiplayer.isHost) {
        // we generate it ourselves (host/solo have the AI keys)
        const character = await DungeonMaster.generateCharacter(desc, name);
        updateAiIndicator();
        const payload = { playerId: App.myId, name, character };
        applyCharacterCreated(payload);
        if (!App.soloMode) window.multiplayer.broadcast('character_created', payload, App.myId);
      } else {
        // non-host peer: ask the host to generate the character
        // (peers don't need their own AI key in this design)
        UI.toast('Request sent to host...');
        window.multiplayer.send('char_request', { playerId: App.myId, name, desc });
      }
    } catch (err) {
      UI.toast('Error generating character: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create character';
    }
  }));

  // --- start adventure (host/solo only) ---
  document.getElementById('btn-start-adventure').addEventListener('click', safeHandler(async () => {
    App.started = true;
    UI.showScreen('screen-game');
    document.getElementById('game-room-label').textContent = App.soloMode
      ? 'Solo adventure' : `Room: ${window.multiplayer.roomCode}`;
    UI.renderDiceButtons(rollDice);
    refreshLobbyOrGameUI();
    setActionInputEnabled(false);
    addHistory({ type: 'system', text: 'The Dungeon Master gathers their thoughts...' });
    try {
      const result = await DungeonMaster.startAdventure(App.state.players);
      updateAiIndicator();
      if (!App.soloMode) window.multiplayer.broadcast('dm_response', result, App.myId);
      applyDmResponse(result);
    } catch (err) {
      addHistory({ type: 'system', text: '⚠ ' + err.message });
      setActionInputEnabled(true);
    }
  }));

  // Non-host peers simply wait until they receive a 'dm_response' + screen
  // switch signal. We use 'dm_response' itself as the trigger.
  window.multiplayer.on('dm_response', safeHandler(() => {
    if (!App.started) {
      App.started = true;
      UI.showScreen('screen-game');
      document.getElementById('game-room-label').textContent = App.soloMode
        ? 'Solo adventure' : `Room: ${window.multiplayer.roomCode}`;
      UI.renderDiceButtons(rollDice);
    }
  }));

  // Host: handle character requests from peers without their own AI key
  window.multiplayer.on('char_request', async (payload, fromId) => {
    if (!window.multiplayer.isHost) return;
    try {
      const character = await DungeonMaster.generateCharacter(payload.desc, payload.name);
      const result = { playerId: payload.playerId, name: payload.name, character };
      applyCharacterCreated(result);
      window.multiplayer.broadcast('character_created', result, App.myId);
    } catch (err) {
      console.error(err);
      window.multiplayer.broadcast('char_error', { playerId: payload.playerId, message: err.message }, App.myId);
    }
  });

  // Peer: get a clear notification if the host couldn't generate the character
  window.multiplayer.on('char_error', safeHandler((payload) => {
    if (payload.playerId === App.myId) {
      UI.toast('Error generating character: ' + payload.message);
    }
  }));

  // --- send action ---
  document.getElementById('btn-send-action').addEventListener('click', safeHandler(sendAction));
  document.getElementById('input-action').addEventListener('keydown', safeHandler((e) => {
    if (e.key === 'Enter') sendAction();
  }));

  // --- close inventory modal (wasn't wired up anywhere) ---
  document.getElementById('btn-inv-close').addEventListener('click', safeHandler(() => UI.hideModal('modal-inventory')));

  async function sendAction() {
    const input = document.getElementById('input-action');
    const text = input.value.trim();
    if (!text || App.busy) return;
    const me = App.state.players[App.myId];
    if (me?.character && CharacterFactory.isDead(me.character)) {
      UI.toast('Your character has died and can no longer act.');
      return;
    }
    input.value = '';
    addHistory({ type: 'action', player: me.name, text });

    if (App.soloMode) {
      App.busy = true;
      setActionInputEnabled(false);
      await runDmTurn(me.name, text);
    } else if (window.multiplayer.isHost) {
      App.busy = true;
      setActionInputEnabled(false);
      window.multiplayer.broadcast('action_echo', { playerName: me.name, text }, App.myId);
      await runDmTurn(me.name, text);
    } else {
      window.multiplayer.send('action', { playerName: me.name, text });
    }
  }

  // --- dice ---
  function rollDice(sides) {
    const modifier = parseInt(document.getElementById('dice-modifier').value, 10) || 0;
    const result = Dice.rollWithModifier(sides, modifier);
    const me = App.state.players[App.myId];
    const label = result.label + (result.isCrit ? ' — CRITICAL!' : result.isFumble ? ' — FUMBLE!' : '');
    dispatch('roll', { playerName: me.name, label }, applyRoll);
  }
}