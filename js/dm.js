/**
 * DungeonMaster — bouwt de prompts voor de AI en parseert de
 * antwoorden. De AI wordt gevraagd om na het verhaal een optioneel
 * machine-leesbaar [ACTIONS]{...}[/ACTIONS] blok te sturen zodat we
 * loot-aanbiedingen en level-ups betrouwbaar kunnen detecteren zonder
 * de proza te moeten parsen.
 */
const DungeonMaster = {
  CHAR_SYSTEM_PROMPT: `Je bent een Dungeons & Dragons personage-generator.
Je krijgt een korte tekstuele beschrijving van een speler over wie ze willen spelen.
Antwoord UITSLUITEND met geldige JSON, zonder markdown-codeblok, zonder uitleg, in dit exacte formaat:
{
  "name": "string",
  "class": "string (bv. Krijger, Tovenaar, Schurk, Waarzegger)",
  "race": "string (bv. Mens, Half-elf, Dwerg, Halfling)",
  "level": 1,
  "background": "1-2 zinnen achtergrondverhaal",
  "stats": {"STR": 8-16, "DEX": 8-16, "CON": 8-16, "INT": 8-16, "WIS": 8-16, "CHA": 8-16},
  "hp": {"current": number, "max": number},
  "inventory": [{"name": "string", "description": "string"}],
  "skills": ["string", "string"],
  "spells": [{"name": "string", "description": "korte beschrijving van het effect"}]
}
Baseer klasse, stats en starteruitrusting logisch op de beschrijving van de speler. Max HP tussen 8 en 14 voor een level 1 personage, afhankelijk van klasse (krijgers/barbaren hoger, tovenaars lager). Geef 2-4 startitems en 2-4 skills. Gebruik "spells" ALLEEN voor klassen die logischerwijs spreuken kennen (bv. Tovenaar, Waarzegger, Klerk, Druïde); geef die klassen 2-4 startspreuken die passen bij het personage. Voor niet-magische klassen (bv. Krijger, Schurk) laat je "spells" een lege array. Schrijf alles in het Nederlands.`,

  DM_SYSTEM_PROMPT: `Je bent een ervaren, sfeervolle Dungeons & Dragons Dungeon Master die een tekstueel avontuur vertelt in het Nederlands.
Regels:
- Schrijf UITERST bondig: je verhaaltekst per beurt bestaat uit MAXIMAAL 3 zinnen, nooit meer. Kies de meest sfeervolle en relevante details, laat de rest weg.
- Reageer op de acties en dobbelsteenworpen van de spelers; laat worpen daadwerkelijk gevolgen hebben (een lage worp = een tegenslag, een hoge worp = succes of een kritiek voordeel).
- Spreek spelers bij naam aan wanneer relevant.
- Wanneer je vindt dat het verhaal om een dobbelsteenworp vraagt die nog niet gegeven is, vraag er expliciet om in plaats van zelf een uitkomst te verzinnen.
- Je krijgt de meest recente dobbelsteenworp van de handelende speler expliciet te zien (indien aanwezig) vlak voor hun actie. Gebruik dat resultaat daadwerkelijk: een lage worp = een tegenslag, een hoge worp = succes of een kritiek voordeel. Verzin nooit een eigen uitkomst als er al een worp gegeven is.
- Wanneer een speler een item zou moeten vinden, of wanneer een personage genoeg heeft gepresteerd om te levelen, voeg NA je verhaaltekst een apart blok toe (zie hieronder). Doe dit alleen als het echt gepast is, niet elke beurt. Als een spellcaster tijdens het levelen een logische nieuwe spreuk zou leren, mag je die toevoegen via "newSpells".

Na je verhaaltekst mag je, indien van toepassing, dit blok toevoegen (anders helemaal weglaten):
[ACTIONS]
{"loot": [{"player": "exacte spelernaam", "item": "itemnaam", "description": "korte beschrijving"}], "levelup": [{"player": "exacte spelernaam", "newLevel": number, "newMaxHP": number, "statChanges": {"STR": 1}, "newSkills": ["string"], "newSpells": [{"name": "string", "description": "string"}]}]}
[/ACTIONS]
Gebruik lege arrays voor loot/levelup als er niets te melden is, of laat het hele blok weg. Gebruik voor "player" ALTIJD de exacte SPELERNAAM (het woord na "speler:" in de spelerslijst hieronder), NIET de personagenaam.`,

  async generateCharacter(description, playerName) {
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.CHAR_SYSTEM_PROMPT },
      { role: 'user', content: `Spelernaam: ${playerName}\nBeschrijving: ${description}` }
    ]);
    const json = extractJson(text);
    return CharacterFactory.sanitize(json, playerName);
  },

  async startAdventure(players) {
    const partySummary = summarizeParty(players);
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.DM_SYSTEM_PROMPT },
      { role: 'user', content: `De volgende groep avonturiers begint een nieuw avontuur:\n${partySummary}\n\nSchets een sfeervolle openingsscene die de groep samenbrengt en eindig met een duidelijke situatie waarop de spelers kunnen reageren.` }
    ]);
    return parseDmResponse(text);
  },

  async continueStory(players, recentHistory, actingPlayerName, actionText) {
    const partySummary = summarizeParty(players);
    const historyText = recentHistory.slice(-12).map(h => formatHistoryLine(h)).join('\n');
    const rollLine = findRecentRollLine(recentHistory, actingPlayerName);
    const text = await window.aiManager.chat([
      { role: 'system', content: DungeonMaster.DM_SYSTEM_PROMPT },
      { role: 'user', content: `Groep:\n${partySummary}\n\nRecent verloop:\n${historyText}\n\n${rollLine}${actingPlayerName} doet nu: "${actionText}"\n\nVertel wat er gebeurt.` }
    ]);
    return parseDmResponse(text);
  }
};

function summarizeParty(players) {
  return Object.values(players).filter(p => p.character).map(p => {
    const c = p.character;
    const spells = Array.isArray(c.spells) ? c.spells : [];
    return `- ${c.name} (speler: ${p.name}), ${c.race} ${c.class}, level ${c.level}, HP ${c.hp.current}/${c.hp.max}, stats STR${c.stats.STR}/DEX${c.stats.DEX}/CON${c.stats.CON}/INT${c.stats.INT}/WIS${c.stats.WIS}/CHA${c.stats.CHA}, inventaris: ${c.inventory.map(i => i.name).join(', ') || 'leeg'}, spreuken: ${spells.map(s => s.name).join(', ') || 'geen'}`;
  }).join('\n');
}

/**
 * Zoekt terug in de geschiedenis naar de meest recente dobbelsteenworp van
 * de handelende speler die bij hun huidige beurt hoort (dus na hun vorige
 * actie), zodat de AI die worp gegarandeerd te zien krijgt — ook als hij
 * buiten het laatste-12-regels-venster van de historyText zou vallen.
 */
function findRecentRollLine(history, playerName) {
  let skippedCurrentAction = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.type === 'action' && h.player === playerName) {
      if (!skippedCurrentAction) { skippedCurrentAction = true; continue; }
      break; // oudere actie van dezelfde speler: eerdere worpen horen niet meer bij deze beurt
    }
    if (h.type === 'roll' && h.player === playerName) {
      return `Laatste dobbelsteenworp van ${playerName}: ${h.text}.\n\n`;
    }
  }
  return '';
}

function formatHistoryLine(h) {
  if (h.type === 'narrative') return `DM: ${h.text}`;
  if (h.type === 'action') return `${h.player}: ${h.text}`;
  if (h.type === 'roll') return `[worp] ${h.player}: ${h.text}`;
  return h.text;
}

function parseDmResponse(rawText) {
  const actionsMatch = rawText.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/i);
  let loot = [];
  let levelup = [];
  let narrative = rawText;

  if (actionsMatch) {
    narrative = rawText.slice(0, actionsMatch.index).trim();
    try {
      const parsed = JSON.parse(actionsMatch[1].trim());
      loot = Array.isArray(parsed.loot) ? parsed.loot : [];
      levelup = Array.isArray(parsed.levelup) ? parsed.levelup : [];
    } catch (e) {
      console.warn('[DM] kon ACTIONS-blok niet parsen:', e);
    }
  }
  return { narrative: narrative.trim(), loot, levelup };
}

function extractJson(text) {
  // Verwijder eventuele ```json codeblokken en pak het eerste { ... } blok
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    console.warn('[DM] kon character JSON niet parsen:', e, cleaned);
    return null;
  }
}

window.DungeonMaster = DungeonMaster;