/**
 * CS2 weapon catalogue shared by the offline template generator, the labeling tool and the UI.
 * Ids match the folder names under `weapon-samples/` (see its README).
 */
export const WEAPON_LABELS: Record<string, string> = {
  glock: 'Glock-18',
  usp_s: 'USP-S',
  p2000: 'P2000',
  dual_berettas: 'Dual Berettas',
  p250: 'P250',
  tec9: 'Tec-9',
  five_seven: 'Five-SeveN',
  cz75: 'CZ75-Auto',
  deagle: 'Desert Eagle',
  r8_revolver: 'R8 Revolver',
  mp9: 'MP9',
  mac10: 'MAC-10',
  mp7: 'MP7',
  mp5sd: 'MP5-SD',
  ump45: 'UMP-45',
  p90: 'P90',
  bizon: 'PP-Bizon',
  galil: 'Galil AR',
  famas: 'FAMAS',
  ak47: 'AK-47',
  m4a4: 'M4A4',
  m4a1s: 'M4A1-S',
  sg553: 'SG 553',
  aug: 'AUG',
  ssg08: 'SSG 08',
  awp: 'AWP',
  scar20: 'SCAR-20',
  g3sg1: 'G3SG1',
  nova: 'Nova',
  xm1014: 'XM1014',
  sawedoff: 'Sawed-Off',
  mag7: 'MAG-7',
  m249: 'M249',
  negev: 'Negev',
}

/**
 * Approximate CS2 cyclic rates (rounds/min) for automatic weapons. Used to space the synthetic
 * burst overlay in the template generator, and as a prior for the expected inter-shot interval.
 * Anything not listed falls back to `DEFAULT_WEAPON_RPM` (a plausible rapid manual click rate for
 * semi-auto pistols/shotguns/snipers).
 */
export const WEAPON_RPM: Record<string, number> = {
  ak47: 600,
  m4a4: 666,
  m4a1s: 600,
  galil: 666,
  famas: 750,
  sg553: 560,
  aug: 560,
  mp9: 857,
  mac10: 800,
  mp7: 750,
  mp5sd: 750,
  ump45: 666,
  p90: 800,
  bizon: 600,
  m249: 750,
  negev: 750,
}

export const DEFAULT_WEAPON_RPM = 400

export const WEAPON_IDS = Object.keys(WEAPON_LABELS)

export function weaponLabel(weaponId: string): string {
  return WEAPON_LABELS[weaponId] ?? weaponId
}
