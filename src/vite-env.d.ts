/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web3Forms feedback form key. Public: Vite inlines it into the bundle. */
  readonly VITE_WEB3FORMS_KEY: string
  /** Google Analytics measurement ID. Public: visible in the loaded script. */
  readonly VITE_GA_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
