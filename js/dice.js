/**
 * Dice — virtual dice d4 through d100.
 */
const Dice = {
  TYPES: [4, 6, 8, 10, 12, 20, 100],

  roll(sides) {
    return 1 + Math.floor(Math.random() * sides);
  },

  /** Rolls and builds a readable result object, including an optional modifier. */
  rollWithModifier(sides, modifier = 0) {
    const raw = Dice.roll(sides);
    const total = raw + Number(modifier || 0);
    const modStr = modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : '';
    return {
      sides,
      raw,
      modifier: Number(modifier || 0),
      total,
      label: `1d${sides}${modStr} = ${total}`,
      isCrit: sides === 20 && raw === 20,
      isFumble: sides === 20 && raw === 1
    };
  }
};

window.Dice = Dice;