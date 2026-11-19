/// <reference types="astro/client" />

// Newly shipped HTML attributes not yet in Astro's JSX typings.
declare namespace astroHTML.JSX {
  interface HTMLAttributes {
    focusgroup?: string;
    focusgroupstart?: string | boolean;
  }
}
