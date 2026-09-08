/**
 * DungeonMaster — builds the prompts sent to the AI and parses the
 * responses. The AI is asked to follow its narration with an optional
 * machine-readable [ACTIONS]{...}[/ACTIONS] block so we can reliably
 * detect loot offers, level-ups and HP changes without having to
 * parse free-form prose.
 */
const DungeonMaster = {
  CHAR_SYSTEM_PROMPT: `You are a Dungeons & Dragons character generator.
You will receive a short text description from a player about who they want to play.
Respond ONLY with valid JSON, no markdown code fence, no explanation, in this exact format:
{
  "name": "string",
  "class": "string (e.g. Fighter, Wizard, Rogue, Cleric, Barbarian, Druid, Bard, Ranger, Paladin, Warlock, Sorcerer, Monk)",
  "race": "string (e.g. Human, Half-Elf, Dwarf, Halfling, Elf, Half-Orc, Dragonborn, Gnome, Tiefling)",
  "level": 1,
  "background": "1-2 sentence backstory",
  "stats": {"STR": 8-16, "DEX": 8-16, "CON": 8-16, "INT": 8-16, "WIS": 8-16, "CHA": 8-16},
  "hp": {"current": number, "max": number},
  "inventory": [{"name": "string", "description": "string"}],
  "skills": ["string", "string"],
  "spells": [{"name": "string", "description": "short description of the effect"}]
}
Base the class, stats and starting gear logically on the player's description. Max HP between 8 and 14 for a level 1 character, depending on class (Fighters/Barbarians higher, Wizards lower). Give 2-4 starting items and 2-4 skills. Only use "spells" for classes that would logically know spells (e.g. Wizard, Sorcerer, Cleric, Druid, Warlock, Bard, Paladin, Ranger); give those classes 2-4 starting spells that fit the character, using real D&D spell names where appropriate (e.g. Fire Bolt, Cure Wounds, Mage Armor). For non-magical classes (e.g. Fighter, Rogue, Barbarian) leave "spells" an empty array. Write everything in English.`,

  DM_SYSTEM_PROMPT: `You are an experienced, atmospheric Dungeons & Dragons Dungeon Master narrating a text-based adventure in English, using real D&D terminology (HP, Armor Class, saving throws, classes, spells, etc. by their proper names).
Rules:
- Write EXTREMELY concisely: your narration per turn is a MAXIMUM of 3 sentences, never more. Pick the most atmospheric, relevant details and drop the rest.
- React to the players' actions and dice rolls; let rolls genuinely matter (a low roll = a setback, a high roll = success or a critical advantage).
- Address players by name when relevant.
- You will be shown the most recent dice roll of the acting player explicitly (when one exists) right before their action. Actually use that result — never invent your own outcome when a roll has already been given, and never ask for a roll if one was already provided for this action.
- When you feel the story calls for a dice roll that hasn't been made yet, explicitly ask for one instead of inventing an outcome yourself.
- When a player should take damage or be healed (from combat, traps, potions, spells, rest, etc.), report it via "hpChanges" in the ACTIONS block below so the game can update their HP bar. Base the amount on the fiction and any relevant roll — don't be shy about dealing real damage when the story calls for it, but keep numbers reasonable for a level 1-5 character (typically 1-12 damage, more for a critical hit or a serious blow).
- If a player's HP would hit 0, narrate the consequence appropriately (falling unconscious, or death, depending on tone and severity) but let the "hpChanges" amount do the actual accounting — don't declare someone dead in prose if their HP wouldn't actually reach 0.
- When a player should find an item, or when a character has accomplished enough to level up, add a separate block AFTER your narration (see below). Only do this when it's genuinely warranted, not every turn. If a spellcaster would logically learn a new spell on level up, you may add it via "newSpells".

After your narration, you may (if applicable) add this block (otherwise omit it entirely):
[ACTIONS]
{"loot": [{"player": "exact player name", "item": "item name", "description": "short description"}], "levelup": [{"player": "exact player name", "newLevel": number, "newMaxHP": number, "statChanges": {"STR": 1}, "newSkills": ["string"], "newSpells": [{"name": "string", "description": "string"}]}], "hpChanges": [{"player": "exact player name", "amount": number, "reason": "short reason"}]}
[/ACTIONS]
Use empty arrays for loot/levelup/hpChanges when there's nothing to report, or omit the whole block. For "amount" in hpChanges, use a NEGATIVE number for damage and a POSITIVE number for healing. For "player" ALWAYS use the exact PLAYER NAME (the word after "player:" in the party list below), NOT the character name.`,

  async generateCharacter(description, playerName) {
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.CHAR_SYSTEM_PROMPT },
      { role: 'user', content: `Player name: ${playerName}\nDescription: ${description}` }
    ]);
    const json = extractJson(text);
    if (!json) {
      console.warn('[DM] Could not parse the AI response for the character as JSON:', text);
      throw new Error('The AI did not return a valid character. Please try again (maybe with a shorter description).');
    }
    return CharacterFactory.sanitize(json, playerName);
  },

  async startAdventure(players) {
    const partySummary = summarizeParty(players);
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.DM_SYSTEM_PROMPT },
      { role: 'user', content: `The following party of adventurers is starting a new adventure:\n${partySummary}\n\nSketch an atmospheric opening scene that brings the group together and end with a clear situation the players can react to.` }
    ]);
    return parseDmResponse(text);
  },

  async continueStory(players, recentHistory, actingPlayerName, actionText) {
    const partySummary = summarizeParty(players);
    const historyText = recentHistory.slice(-12).map(h => formatHistoryLine(h)).join('\n');
    const rollLine = findRecentRollLine(recentHistory, actingPlayerName);
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.DM_SYSTEM_PROMPT },
      { role: 'user', content: `Party:\n${partySummary}\n\nRecent events:\n${historyText}\n\n${rollLine}${actingPlayerName} now does: "${actionText}"\n\nDescribe what happens.` }
    ]);
    return parseDmResponse(text);
  }
};

function summarizeParty(players) {
  return Object.values(players).filter(p => p.character).map(p => {
    const c = p.character;
    const spells = Array.isArray(c.spells) ? c.spells : [];
    const dead = CharacterFactory.isDead(c) ? ', STATUS: DEAD' : '';
    return `- ${c.name} (player: ${p.name}), ${c.race} ${c.class}, level ${c.level}, HP ${c.hp.current}/${c.hp.max}${dead}, stats STR${c.stats.STR}/DEX${c.stats.DEX}/CON${c.stats.CON}/INT${c.stats.INT}/WIS${c.stats.WIS}/CHA${c.stats.CHA}, inventory: ${c.inventory.map(i => i.name).join(', ') || 'empty'}, spells: ${spells.map(s => s.name).join(', ') || 'none'}`;
  }).join('\n');
}

function formatHistoryLine(h) {
  if (h.type === 'narrative') return `DM: ${h.text}`;
  if (h.type === 'action') return `${h.player}: ${h.text}`;
  if (h.type === 'roll') return `[roll] ${h.player}: ${h.text}`;
  return h.text;
}

/**
 * Looks back through the history for the most recent dice roll made by
 * the acting player that belongs to their current turn (i.e. made after
 * their previous action), so the AI is guaranteed to see it — even if it
 * would otherwise fall outside the last-12-lines window of historyText.
 */
function findRecentRollLine(history, playerName) {
  let skippedCurrentAction = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.type === 'action' && h.player === playerName) {
      if (!skippedCurrentAction) { skippedCurrentAction = true; continue; } // skip the action just sent
      break; // an older action from the same player: earlier rolls no longer belong to this turn
    }
    if (h.type === 'roll' && h.player === playerName) {
      return `Most recent dice roll from ${playerName}: ${h.text}.\n\n`;
    }
  }
  return '';
}

function parseDmResponse(rawText) {
  const actionsMatch = rawText.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/i);
  let loot = [];
  let levelup = [];
  let hpChanges = [];
  let narrative = rawText;

  if (actionsMatch) {
    narrative = rawText.slice(0, actionsMatch.index).trim();
    try {
      const parsed = JSON.parse(actionsMatch[1].trim());
      loot = Array.isArray(parsed.loot) ? parsed.loot : [];
      levelup = Array.isArray(parsed.levelup) ? parsed.levelup : [];
      hpChanges = Array.isArray(parsed.hpChanges) ? parsed.hpChanges : [];
    } catch (e) {
      console.warn('[DM] Could not parse the ACTIONS block:', e);
    }
  }
  return { narrative: narrative.trim(), loot, levelup, hpChanges };
}

function extractJson(text) {
  // Strip any ```json code fences and grab the first { ... } block
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // Some models drop a trailing comma right before } or ], which the
    // standard JSON.parse rejects — try to repair that before giving up.
    try {
      const repaired = candidate.replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(repaired);
    } catch (e2) {
      console.warn('[DM] Could not parse character JSON:', e2, cleaned);
      return null;
    }
  }
}

window.DungeonMaster = DungeonMaster;