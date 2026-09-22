/**
 * Publishes the host's real window insets as CSS variables.
 *
 * `env(safe-area-inset-*)` is not enough on Android. In a WebView those values
 * only ever describe *display cutouts* - the notch - and stay 0 for the status
 * bar and the gesture/navigation bar. Since the app draws edge to edge
 * (targetSdk 35 makes that the default, and StatusBar.setOverlaysWebView makes
 * it explicit), relying on env() puts the bottom navigation underneath the
 * gesture pill and the header under the clock.
 *
 * MainActivity therefore reads the true insets from the window and calls
 * `window.__xrncalInsets`, which is installed here. The values are CSS pixels,
 * already divided by the display density on the native side.
 */

export interface HostInsets {
  top: number
  bottom: number
  left: number
  right: number
}

declare global {
  interface Window {
    __xrncalInsets?: (insets: HostInsets) => void
  }
}

function apply(insets: HostInsets): void {
  const style = document.documentElement.style
  style.setProperty('--xrncal-inset-top', `${insets.top}px`)
  style.setProperty('--xrncal-inset-bottom', `${insets.bottom}px`)
  style.setProperty('--xrncal-inset-left', `${insets.left}px`)
  style.setProperty('--xrncal-inset-right', `${insets.right}px`)
}

export function installWindowInsets(): void {
  // Sensible zeroes so the layout is correct even if the host never calls -
  // the CSS falls back to env() behind these.
  apply({ top: 0, bottom: 0, left: 0, right: 0 })

  window.__xrncalInsets = (insets: HostInsets) => {
    // Guard against a malformed payload rather than writing NaN into the
    // custom properties, which would silently collapse the padding.
    const safe = (n: unknown): number => (typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0)
    apply({
      top: safe(insets?.top),
      bottom: safe(insets?.bottom),
      left: safe(insets?.left),
      right: safe(insets?.right)
    })
  }
}
