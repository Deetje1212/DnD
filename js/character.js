/**
 * Character — hulpfuncties voor het DnD character sheet.
 * Een sheet is een plain object zodat het probleemloos over PeerJS
 * (JSON-serialiseerbaar) verstuurd kan worden.
 */
const CharacterFactory = {
  empty(name) {
    return {
      name: name || 'Naamloos',
      class: '???',
      race: '???',
      level: 1,
      background: '',
      stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
      hp: { current: 10, max: 10 },
      inventory: [],
      skills: [],
      spells: []
    };
  },

  /** Valideert en normaliseert een (mogelijk onvolledig) AI-gegenereerd sheet. */
  sanitize(raw, fallbackName) {
    const base = CharacterFactory.empty(fallbackName);
    if (!raw || typeof raw !== 'object') return base;

    const stats = { ...base.stats, ...(raw.stats || {}) };
    Object.keys(stats).forEach(k => {
      stats[k] = clampInt(stats[k], 1, 20, base.stats[k]);
    });

    const maxHp = clampInt(raw.hp?.max, 1, 999, 10);
    const curHp = clampInt(raw.hp?.current, 0, maxHp, maxHp);

    return {
      name: (raw.name || fallbackName || base.name).toString().slice(0, 40),
      class: (raw.class || base.class).toString().slice(0, 30),
      race: (raw.race || base.race).toString().slice(0, 30),
      level: clampInt(raw.level, 1, 20, 1),
      background: (raw.background || '').toString().slice(0, 300),
      stats,
      hp: { current: curHp, max: maxHp },
      inventory: Array.isArray(raw.inventory)
        ? raw.inventory.map(it => sanitizeItem(it)).filter(Boolean)
        : [],
      skills: Array.isArray(raw.skills) ? raw.skills.map(s => String(s).slice(0, 40)).slice(0, 12) : [],
      spells: Array.isArray(raw.spells)
        ? raw.spells.map(sp => sanitizeItem(sp)).filter(Boolean)
        : []
    };
  },

  applyLevelUp(sheet, update) {
    const next = structuredClone(sheet);
    if (update.newLevel) next.level = clampInt(update.newLevel, next.level, 20, next.level);
    if (update.newMaxHP) {
      const diff = update.newMaxHP - next.hp.max;
      next.hp.max = clampInt(update.newMaxHP, 1, 999, next.hp.max);
      next.hp.current = clampInt(next.hp.current + Math.max(diff, 0), 0, next.hp.max, next.hp.current);
    }
    if (update.statChanges && typeof update.statChanges === 'object') {
      Object.entries(update.statChanges).forEach(([stat, delta]) => {
        if (next.stats[stat] !== undefined) {
          next.stats[stat] = clampInt(next.stats[stat] + Number(delta || 0), 1, 24, next.stats[stat]);
        }
      });
    }
    if (Array.isArray(update.newSkills)) {
      update.newSkills.forEach(s => {
        const skill = String(s).slice(0, 40);
        if (!next.skills.includes(skill)) next.skills.push(skill);
      });
    }
    if (!Array.isArray(next.spells)) next.spells = [];
    if (Array.isArray(update.newSpells)) {
      update.newSpells.forEach(sp => {
        const clean = sanitizeItem(sp);
        if (clean && !next.spells.some(s => s.name === clean.name)) next.spells.push(clean);
      });
    }
    return next;
  },

  addItem(sheet, item) {
    const next = structuredClone(sheet);
    const clean = sanitizeItem(item);
    if (clean) next.inventory.push(clean);
    return next;
  },

  removeItem(sheet, itemName) {
    const next = structuredClone(sheet);
    const idx = next.inventory.findIndex(i => i.name === itemName);
    if (idx >= 0) next.inventory.splice(idx, 1);
    return next;
  },

  addSpell(sheet, spell) {
    const next = structuredClone(sheet);
    const clean = sanitizeItem(spell);
    if (!Array.isArray(next.spells)) next.spells = [];
    if (clean && !next.spells.some(s => s.name === clean.name)) next.spells.push(clean);
    return next;
  },

  removeSpell(sheet, spellName) {
    const next = structuredClone(sheet);
    if (!Array.isArray(next.spells)) next.spells = [];
    const idx = next.spells.findIndex(s => s.name === spellName);
    if (idx >= 0) next.spells.splice(idx, 1);
    return next;
  },

  applyDamageOrHeal(sheet, delta) {
    const next = structuredClone(sheet);
    next.hp.current = clampInt(next.hp.current + delta, 0, next.hp.max, next.hp.current);
    return next;
  }
};

function sanitizeItem(it) {
  if (!it) return null;
  if (typeof it === 'string') return { name: it.slice(0, 60), description: '' };
  if (typeof it === 'object' && it.name) {
    return { name: String(it.name).slice(0, 60), description: String(it.description || '').slice(0, 200) };
  }
  return null;
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

window.CharacterFactory = CharacterFactory;