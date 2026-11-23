/// <reference types="astro/client" />

// Newly shipped HTML attributes not yet in Astro's JSX typings.
declare namespace astroHTML.JSX {
  interface HTMLAttributes {
    focusgroup?: string;
    focusgroupstart?: string | boolean;
    closedby?: "any" | "closerequest" | "none";
  }
}

declare namespace App {
  interface Locals {
    user?: import("./server/auth").SessionUser;
  }
}
