/**
 * UI — pure rendering functies. Leest uit App.state (main.js), schrijft
 * naar het DOM. Bevat geen netwerk- of AI-logica.
 */
const UI = {
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  },

  showModal(id) { document.getElementById(id).classList.remove('hidden'); },
  hideModal(id) { document.getElementById(id).classList.add('hidden'); },

  toast(message) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  },

  // ---------- Lobby ----------
  renderLobbyPlayerList(players) {
    const el = document.getElementById('lobby-player-list');
    el.innerHTML = '';
    Object.values(players).forEach(p => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between border border-line rounded px-3 py-2';
      row.innerHTML = `
        <span>${escapeHtml(p.name)}</span>
        <span class="text-xs ${p.character ? 'text-forest' : 'text-parchment/40'}">
          ${p.character ? `${escapeHtml(p.character.class)} klaar` : 'nog geen personage'}
        </span>`;
      el.appendChild(row);
    });
  },

  // ---------- Dice ----------
  renderDiceButtons(onRoll) {
    const el = document.getElementById('dice-buttons');
    el.innerHTML = '';
    Dice.TYPES.forEach(sides => {
      const btn = document.createElement('button');
      btn.className = 'dice-btn';
      btn.textContent = `d${sides}`;
      btn.addEventListener('click', () => onRoll(sides));
      el.appendChild(btn);
    });
  },

  // ---------- Story log ----------
  appendLog(entry) {
    const el = document.getElementById('story-log');
    const div = document.createElement('div');
    div.className = `log-entry log-${entry.type}`;
    if (entry.type === 'system') {
      div.textContent = entry.text;
    } else if (entry.type === 'roll') {
      div.textContent = `🎲 ${entry.player}: ${entry.text}`;
    } else if (entry.type === 'action') {
      div.innerHTML = `<span class="text-gold">${escapeHtml(entry.player)}</span> ${escapeHtml(entry.text)}`;
    } else {
      div.textContent = entry.text; // narrative — AI text, rendered as plain text (no HTML injection)
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },

  renderFullLog(history) {
    const el = document.getElementById('story-log');
    el.innerHTML = '';
    history.forEach(h => UI.appendLog(h));
  },

  // ---------- Character sheet ----------
  renderCharacterSheet(character) {
    const el = document.getElementById('character-sheet-panel');
    if (!character) {
      el.innerHTML = `<p class="text-sm text-parchment/40">Nog geen personage.</p>`;
      return;
    }
    const c = character;
    const hpPct = Math.max(0, Math.min(100, (c.hp.current / c.hp.max) * 100));
    el.innerHTML = `
      <div class="mb-3">
        <p class="font-display text-2xl leading-tight">${escapeHtml(c.name)}</p>
        <p class="text-xs text-parchment/50">${escapeHtml(c.race)} ${escapeHtml(c.class)} · Level ${c.level}</p>
      </div>
      <div class="mb-3">
        <div class="flex justify-between text-xs mb-1"><span>HP</span><span>${c.hp.current} / ${c.hp.max}</span></div>
        <div class="hp-bar-track"><div class="hp-bar-fill" style="width:${hpPct}%"></div></div>
      </div>
      <div class="grid grid-cols-3 gap-x-2 mb-4">
        ${Object.entries(c.stats).map(([k, v]) => `
          <div class="text-center border border-line rounded py-1 mb-1">
            <div class="text-[10px] text-parchment/50">${k}</div>
            <div class="font-display text-lg">${v}</div>
          </div>`).join('')}
      </div>
      ${c.skills.length ? `
      <div class="mb-4">
        <p class="text-xs text-parchment/50 mb-1">Vaardigheden</p>
        <p class="text-sm">${c.skills.map(escapeHtml).join(' · ')}</p>
      </div>` : ''}
      ${(c.spells && c.spells.length) ? `
      <div class="mb-4">
        <p class="text-xs text-parchment/50 mb-1">Spreuken</p>
        <div class="space-y-1">
          ${c.spells.map(s => `
            <div class="inv-item" title="${escapeHtml(s.description || '')}">${escapeHtml(s.name)}</div>
          `).join('')}
        </div>
      </div>` : ''}
      <div class="mb-2 flex items-center justify-between">
        <p class="text-xs text-parchment/50">Inventaris</p>
        <button id="btn-open-inventory" class="text-xs text-gold hover:underline">bewerken</button>
      </div>
      <div class="space-y-1">
        ${c.inventory.length ? c.inventory.map(i => `
          <div class="inv-item" title="${escapeHtml(i.description || '')}">${escapeHtml(i.name)}</div>
        `).join('') : `<p class="text-xs text-parchment/30 italic">leeg</p>`}
      </div>
    `;
  },

  populateActiveSheetSelector(players, myId, onChange) {
    const sel = document.getElementById('select-active-sheet');
    const prev = sel.value;
    sel.innerHTML = '';
    Object.values(players).filter(p => p.character).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.id === myId ? `${p.name} (jij)` : p.name;
      sel.appendChild(opt);
    });
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    sel.onchange = () => onChange(sel.value);
  },

  // ---------- Party status (right column) ----------
  renderPartyStatus(players) {
    const el = document.getElementById('party-status');
    el.innerHTML = '';
    Object.values(players).forEach(p => {
      const row = document.createElement('div');
      row.className = 'text-sm border border-line rounded px-2 py-1.5';
      if (p.character) {
        const hpPct = Math.max(0, Math.min(100, (p.character.hp.current / p.character.hp.max) * 100));
        row.innerHTML = `
          <div class="flex justify-between mb-1">
            <span>${escapeHtml(p.character.name)}</span>
            <span class="text-parchment/50">Lv${p.character.level}</span>
          </div>
          <div class="hp-bar-track"><div class="hp-bar-fill" style="width:${hpPct}%"></div></div>`;
      } else {
        row.innerHTML = `<span class="text-parchment/40">${escapeHtml(p.name)} — personage wordt aangemaakt...</span>`;
      }
      el.appendChild(row);
    });
  },

  // ---------- Loot modal ----------
  showLootModal(lootEvent, onAccept, onDecline) {
    document.getElementById('loot-item-name').textContent = lootEvent.item;
    document.getElementById('loot-item-desc').textContent = lootEvent.description || '';
    UI.showModal('modal-loot');

    const acceptBtn = document.getElementById('btn-loot-accept');
    const declineBtn = document.getElementById('btn-loot-decline');
    const cleanup = () => {
      UI.hideModal('modal-loot');
      acceptBtn.onclick = null;
      declineBtn.onclick = null;
    };
    acceptBtn.onclick = () => { cleanup(); onAccept(); };
    declineBtn.onclick = () => { cleanup(); onDecline(); };
  },

  // ---------- Inventory modal ----------
  renderInventoryModal(character, onAdd, onRemove) {
    const list = document.getElementById('inv-current-list');
    list.innerHTML = '';
    character.inventory.forEach(item => {
      const row = document.createElement('div');
      row.className = 'inv-item';
      row.innerHTML = `<span>${escapeHtml(item.name)}</span>`;
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.className = 'text-blood hover:opacity-70 ml-2';
      rm.onclick = () => onRemove(item.name);
      row.appendChild(rm);
      list.appendChild(row);
    });
    document.getElementById('btn-inv-add').onclick = () => {
      const input = document.getElementById('inv-item-name');
      if (input.value.trim()) {
        onAdd(input.value.trim());
        input.value = '';
      }
    };
    UI.showModal('modal-inventory');
  },

  setAiProviderIndicator(text) {
    document.getElementById('ai-provider-indicator').textContent = text;
  }
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

window.UI = UI;