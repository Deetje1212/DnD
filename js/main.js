/**
 * main.js — applicatiestatus + wiring. Bevat de "dispatch"-laag die
 * ervoor zorgt dat elke actie eerst optimistisch lokaal wordt
 * toegepast, en daarna (indien van toepassing) over het netwerk
 * gedeeld wordt — zonder dubbele toepassing bij de afzender zelf.
 */
const App = {
  state: {
    players: {},   // id -> {id, name, character}
    history: []    // log entries: {type, text, player?}
  },
  myId: null,
  myName: 'Speler',
  soloMode: false,
  started: false,
  busy: false // true terwijl er op een AI-antwoord gewacht wordt
};

// ============================================================
// Dispatch layer
// ============================================================
function dispatch(type, payload, applyFn) {
  applyFn(payload, App.myId); // optimistische lokale toepassing
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
// Handlers (gedeeld tussen lokale dispatch en inkomende netwerk-events)
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
    addHistory({ type: 'system', text: `${payload.playerName} laat ${payload.item.name} liggen.` });
    return;
  }
  const p = App.state.players[payload.playerId];
  if (p && p.character) {
    p.character = CharacterFactory.addItem(p.character, payload.item);
    addHistory({ type: 'system', text: `${payload.playerName} pakt ${payload.item.name} op.` });
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

/** Alleen ontvangen (nooit lokaal gedispatched) — de host is de enige die dit genereert. */
function applyDmResponse(payload) {
  addHistory({ type: 'narrative', text: payload.narrative });

  (payload.levelup || []).forEach(lu => {
    const target = findPlayerByName(lu.player);
    if (target && target.character) {
      target.character = CharacterFactory.applyLevelUp(target.character, lu);
      addHistory({ type: 'system', text: `${target.name} bereikt level ${target.character.level}!` });
      UI.toast(`${target.name} levelt op naar ${target.character.level}!`);
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
  setActionInputEnabled(true);
}

function findPlayerByName(playerName) {
  return Object.values(App.state.players).find(p => p.name === playerName);
}

// ============================================================
// Netwerk event registratie
// ============================================================
function wireMultiplayerEvents() {
  const mp = window.multiplayer;

  mp.on('hello', (payload) => {
    // alleen host ontvangt dit
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
    // Alleen de host verwerkt dit: roept de AI aan en zendt het resultaat uit.
    if (!mp.isHost) return;
    addHistory({ type: 'action', player: payload.playerName, text: payload.text });
    mp.broadcast('action_echo', payload, fromId);
    await runDmTurn(payload.playerName, payload.text);
  });
  mp.on('action_echo', (payload, fromId) => {
    if (fromId === App.myId) return; // eigen actie al lokaal getoond
    addHistory({ type: 'action', player: payload.playerName, text: payload.text });
  });

  mp.on('peer_disconnected', () => refreshLobbyOrGameUI());
}

// ============================================================
// AI-aanroepen (alleen host / solo voert deze uit)
// ============================================================
async function runDmTurn(actingPlayerName, actionText) {
  try {
    const result = await DungeonMaster.continueStory(App.state.players, App.state.history, actingPlayerName, actionText);
    if (App.soloMode) {
      applyDmResponse(result);
    } else {
      window.multiplayer.broadcast('dm_response', result, App.myId);
      applyDmResponse(result); // host past ook lokaal toe
    }
  } catch (err) {
    console.error(err);
    addHistory({ type: 'system', text: `⚠ De AI DM kon niet antwoorden: ${err.message}` });
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
      ? (App.soloMode || window.multiplayer.isHost ? 'Iedereen is klaar — begin het avontuur!' : 'Wachten tot de host het avontuur start...')
      : 'Wachten tot iedereen een personage heeft aangemaakt...';
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
    // Als het bekabelen van de knoppen zelf al faalt, willen we dat
    // zeker zien in plaats van een pagina die er levend uitziet maar
    // waarop niets werkt.
    console.error('[App] Kon de UI niet volledig initialiseren:', err);
    if (window.UI) UI.toast('⚠ De pagina kon niet volledig laden: ' + err.message);
  }
});

// Vangnet voor écht onverwachte fouten buiten de knop-handlers om
// (bv. een ontbrekend script, een CDN die niet laadt) — zorgt dat
// zoiets zichtbaar wordt i.p.v. een pagina die stil niets meer doet.
window.addEventListener('error', (e) => {
  console.error('[App] Onverwachte fout:', e.error || e.message);
});

function updateKeyStatus() {
  const el = document.getElementById('ai-key-status');
  el.textContent = window.aiManager.hasAnyKey()
    ? '✓ AI-sleutels ingesteld'
    : '⚠ Nog geen AI-sleutels ingesteld — klik hieronder';
}

function wireStaticButtons() {
  // --- terugknoppen ---
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', safeHandler(() => UI.showScreen(btn.dataset.target)));
  });

  // --- instellingen modal ---
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
      ? 'AI-sleutels opgeslagen (lokaal in je browser).'
      : 'Sleutels ingesteld voor deze sessie — lokaal opslaan lukte niet in deze browser (bv. privémodus), dus na herladen moet je ze opnieuw invullen.');
  }));

  // --- solo ---
  document.getElementById('btn-solo').addEventListener('click', safeHandler(() => {
    if (!window.aiManager.hasAnyKey()) {
      UI.toast('Stel eerst een AI-sleutel in.');
      // Meteen de instellingen-modal openen zodat de speler niet zelf
      // hoeft te zoeken naar de juiste knop.
      document.getElementById('settings-groq').value = window.aiManager.groqKeys.join('\n');
      document.getElementById('settings-gemini').value = window.aiManager.geminiKeys.join('\n');
      UI.showModal('modal-settings');
      return;
    }
    App.soloMode = true;
    App.myId = genUUID();
    App.state.players = { [App.myId]: { id: App.myId, name: 'Speler', character: null } };
    document.getElementById('lobby-room-code').textContent = 'Solo avontuur';
    document.getElementById('input-player-name').value = '';
    UI.renderLobbyPlayerList(App.state.players);
    UI.showScreen('screen-lobby');
  }));

  // --- multiplayer keuze ---
  document.getElementById('btn-multi').addEventListener('click', safeHandler(() => {
    if (!window.aiManager.hasAnyKey()) { UI.toast('Stel eerst een AI-sleutel in (alleen de host heeft ze nodig).'); }
    UI.showScreen('screen-multi-choice');
  }));

  document.getElementById('btn-create-room').addEventListener('click', safeHandler(async () => {
    const statusEl = document.getElementById('multi-status');
    statusEl.textContent = 'Kamer aanmaken...';
    try {
      const roomCode = await window.multiplayer.hostRoom('Speler');
      App.soloMode = false;
      App.myId = window.multiplayer.myId;
      App.state.players = { [App.myId]: { id: App.myId, name: 'Speler', character: null } };
      document.getElementById('lobby-room-code').textContent = `Kamercode: ${roomCode} — deel deze met je vrienden`;
      document.getElementById('input-player-name').value = '';
      UI.renderLobbyPlayerList(App.state.players);
      UI.showScreen('screen-lobby');
    } catch (err) {
      statusEl.textContent = 'Kon geen kamer aanmaken: ' + err.message;
    }
  }));

  document.getElementById('btn-join-room').addEventListener('click', safeHandler(async () => {
    const code = document.getElementById('input-room-code').value.trim();
    const statusEl = document.getElementById('multi-status');
    if (!code) { statusEl.textContent = 'Vul een kamercode in.'; return; }
    statusEl.textContent = 'Verbinden...';
    try {
      await window.multiplayer.joinRoom(code, 'Speler');
      App.soloMode = false;
      App.myId = window.multiplayer.myId;
      App.state.players[App.myId] = { id: App.myId, name: 'Speler', character: null };
      document.getElementById('lobby-room-code').textContent = `Kamercode: ${code}`;
      document.getElementById('input-player-name').value = '';
      UI.renderLobbyPlayerList(App.state.players);
      UI.showScreen('screen-lobby');
    } catch (err) {
      statusEl.textContent = 'Kon niet verbinden: ' + err.message;
    }
  }));

  // --- personage aanmaken ---
  document.getElementById('btn-create-char').addEventListener('click', safeHandler(async () => {
    const name = document.getElementById('input-player-name').value.trim() || 'Speler';
    const desc = document.getElementById('input-char-desc').value.trim();
    if (!desc) { UI.toast('Beschrijf eerst je personage.'); return; }
    if (!window.aiManager.hasAnyKey() && (App.soloMode || window.multiplayer.isHost)) {
      UI.toast('Stel eerst een AI-sleutel in.'); return;
    }
    const btn = document.getElementById('btn-create-char');
    btn.disabled = true;
    btn.textContent = 'Personage wordt gesmeed...';
    try {
      App.myName = name;
      if (App.soloMode || window.multiplayer.isHost) {
        // wij genereren zelf (host/solo hebben de AI-sleutels)
        const character = await DungeonMaster.generateCharacter(desc, name);
        updateAiIndicator();
        const payload = { playerId: App.myId, name, character };
        applyCharacterCreated(payload);
        if (!App.soloMode) window.multiplayer.broadcast('character_created', payload, App.myId);
      } else {
        // niet-host peer: vraag de host om het personage te genereren
        // (peers hebben in dit ontwerp geen eigen AI-sleutel nodig)
        UI.toast('Verzoek verstuurd naar host...');
        window.multiplayer.send('char_request', { playerId: App.myId, name, desc });
      }
    } catch (err) {
      UI.toast('Fout bij personage genereren: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Personage aanmaken';
    }
  }));

  // --- start avontuur (alleen host/solo) ---
  document.getElementById('btn-start-adventure').addEventListener('click', safeHandler(async () => {
    App.started = true;
    UI.showScreen('screen-game');
    document.getElementById('game-room-label').textContent = App.soloMode
      ? 'Solo avontuur' : `Kamer: ${window.multiplayer.roomCode}`;
    UI.renderDiceButtons(rollDice);
    refreshLobbyOrGameUI();
    setActionInputEnabled(false);
    addHistory({ type: 'system', text: 'De Dungeon Master verzamelt zijn gedachten...' });
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

  // Niet-host peers wachten simpelweg tot ze een 'dm_response' + screen
  // switch-signaal krijgen. We gebruiken 'dm_response' zelf als trigger.
  window.multiplayer.on('dm_response', safeHandler(() => {
    if (!App.started) {
      App.started = true;
      UI.showScreen('screen-game');
      document.getElementById('game-room-label').textContent = App.soloMode
        ? 'Solo avontuur' : `Kamer: ${window.multiplayer.roomCode}`;
      UI.renderDiceButtons(rollDice);
    }
  }));

  // Host: verwerk personage-verzoeken van peers zonder eigen AI-sleutel
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

  // Peer: krijg een duidelijke melding als de host het personage niet kon genereren
  window.multiplayer.on('char_error', safeHandler((payload) => {
    if (payload.playerId === App.myId) {
      UI.toast('Fout bij personage genereren: ' + payload.message);
    }
  }));

  // --- actie versturen ---
  document.getElementById('btn-send-action').addEventListener('click', safeHandler(sendAction));
  document.getElementById('input-action').addEventListener('keydown', safeHandler((e) => {
    if (e.key === 'Enter') sendAction();
  }));

  // --- inventaris-modal sluiten (was nergens gekoppeld) ---
  document.getElementById('btn-inv-close').addEventListener('click', safeHandler(() => UI.hideModal('modal-inventory')));

  async function sendAction() {
    const input = document.getElementById('input-action');
    const text = input.value.trim();
    if (!text || App.busy) return;
    input.value = '';
    const me = App.state.players[App.myId];
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

  // --- dobbelstenen ---
  function rollDice(sides) {
    const modifier = parseInt(document.getElementById('dice-modifier').value, 10) || 0;
    const result = Dice.rollWithModifier(sides, modifier);
    const me = App.state.players[App.myId];
    const label = result.label + (result.isCrit ? ' — KRITIEK!' : result.isFumble ? ' — FUMBLE!' : '');
    dispatch('roll', { playerName: me.name, label }, applyRoll);
  }
}