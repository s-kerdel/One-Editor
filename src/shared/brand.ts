// The product name people see (window title, welcome page, Settings). Internal ids — the data folder,
// the app:// host, localStorage keys, TERM_PROGRAM — stay "sec-edit", so renaming never moves user data.
export const BRAND = 'One';

/** "One :: notes" — `::` as in a scope operator: this folder, inside One. */
export const brandTitle = (folder?: string | null): string => (folder ? `${BRAND} :: ${folder}` : BRAND);
