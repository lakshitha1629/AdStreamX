// IIFE entry: exposes window.AdStreamX for <script> embeds.
import { AdStreamX } from './index.ts';

declare global {
  interface Window {
    AdStreamX: typeof AdStreamX;
  }
}
window.AdStreamX = AdStreamX;
