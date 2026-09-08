/**
 * AIManager — robuuste multi-key, multi-provider rotator.
 */
class AIManager {
  constructor() {
    this.groqKeys = [];
    this.geminiKeys = [];
    this.lastUsed = null; // {provider, index} — voor de UI-indicator
    this.deadKeys = new Set(); // "provider:index" die deze sessie al faalden
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem('dnd_ai_keys');
      if (raw) {
        const parsed = JSON.parse(raw);
        this.groqKeys = (parsed.groq || []).filter(Boolean).slice(0, 3);
        this.geminiKeys = (parsed.gemini || []).filter(Boolean).slice(0, 2);
      }
    } catch (e) { /* corrupte opslag negeren */ }
  }

  saveToStorage(groqKeys = [], geminiKeys = []) {
    // Sleutels altijd eerst in het geheugen zetten: zelfs als localStorage
    // hieronder faalt, werkt de app gewoon door voor de rest van deze sessie.
    this.groqKeys = groqKeys.filter(Boolean).slice(0, 3);
    this.geminiKeys = geminiKeys.filter(Boolean).slice(0, 2);
    this.deadKeys.clear();
    try {
      localStorage.setItem('dnd_ai_keys', JSON.stringify({
        groq: this.groqKeys, gemini: this.geminiKeys
      }));
      return true; // gelukt: blijft ook na herladen bewaard
    } catch (e) {
      // localStorage kan geblokkeerd zijn (privémodus, browserinstellingen,
      // bepaalde embedded webviews, enz.) — dat mag de rest van de app
      // niet stuk maken.
      console.warn('[AIManager] kon sleutels niet lokaal opslaan:', e);
      return false; // sleutels werken nog wel voor deze sessie
    }
  }

  hasAnyKey() {
    return this.groqKeys.length > 0 || this.geminiKeys.length > 0;
  }

  _candidateList() {
    const list = [];
    this.groqKeys.forEach((key, i) => list.push({ provider: 'groq', key, index: i }));
    this.geminiKeys.forEach((key, i) => list.push({ provider: 'gemini', key, index: i }));
    return list;
  }

  _isFailoverWorthy(status, bodyText) {
    if ([429, 401, 403].includes(status)) return true;
    const t = (bodyText || '').toLowerCase();
    return t.includes('quota') || t.includes('rate limit') || t.includes('invalid api key');
  }

  async chat(messages) {
    const candidates = this._candidateList();
    if (candidates.length === 0) {
      throw new Error('Geen AI-sleutels ingesteld. Klik op "AI-sleutels instellen" op het titelscherm.');
    }

    let lastError = null;
    for (const cand of candidates) {
      const dedupeKey = `${cand.provider}:${cand.index}`;
      if (this.deadKeys.has(dedupeKey)) continue;

      try {
        const text = cand.provider === 'groq'
          ? await this._callGroq(cand.key, messages)
          : await this._callGemini(cand.key, messages);
        this.lastUsed = { provider: cand.provider, index: cand.index };
        return text;
      } catch (err) {
        lastError = err;
        if (err.failoverWorthy) {
          this.deadKeys.add(dedupeKey);
          console.warn(`[AIManager] key ${dedupeKey} faalde (${err.message}), schakel over naar volgende...`);
          continue;
        }
        continue;
      }
    }
    throw new Error('Alle AI-sleutels zijn uitgeput of ongeldig. Laatste fout: ' + (lastError?.message || 'onbekend'));
  }

  async _callGroq(key, messages) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.9,
        max_tokens: 1200
      })
    });
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`Groq HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      err.failoverWorthy = this._isFailoverWorthy(res.status, bodyText);
      throw err;
    }
    const data = JSON.parse(bodyText);
    return data.choices?.[0]?.message?.content || '';
  }

  async _callGemini(key, messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');

    // Voorkom opeenvolgende dubbele rollen voor Gemini
    const contents = [];
    for (const m of rest) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += `\n\n${m.content}`;
      } else {
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }

    const body = {
      contents,
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      generationConfig: { temperature: 0.9, maxOutputTokens: 1200 }
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      err.failoverWorthy = this._isFailoverWorthy(res.status, bodyText);
      throw err;
    }
    const data = JSON.parse(bodyText);
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  }
}

window.aiManager = new AIManager();