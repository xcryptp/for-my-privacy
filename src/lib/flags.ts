// Build flag: the extensions-page guard ships unless the build sets VITE_FMP_SETTINGS_GUARD=off
// (see .env.noguard and `npm run build:noguard`).
export const SETTINGS_GUARD_BUILD: boolean = import.meta.env.VITE_FMP_SETTINGS_GUARD !== 'off';
