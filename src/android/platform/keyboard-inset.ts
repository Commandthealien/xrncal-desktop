import { Keyboard } from '@capacitor/keyboard'

/**
 * Publishes the soft keyboard's height as a CSS variable.
 *
 * The WebView is deliberately *not* resized when the keyboard opens
 * (`Keyboard.setResizeMode({ mode: 'none' })`): resizing reflows the whole
 * calendar grid behind the editor on every focus change, which is both visibly
 * janky and expensive with a week of events laid out.
 *
 * The cost of not resizing is that a bottom-anchored sheet ends up underneath
 * the keyboard, with its Save button out of reach. Exposing the height lets
 * just the sheet move, leaving the calendar behind it untouched.
 */
export function installKeyboardInset(): void {
  const set = (px: number): void => {
    document.documentElement.style.setProperty('--xrncal-keyboard', `${Math.max(0, px)}px`)
  }

  set(0)

  void Keyboard.addListener('keyboardWillShow', (info) => set(info.keyboardHeight))
  void Keyboard.addListener('keyboardDidShow', (info) => set(info.keyboardHeight))
  void Keyboard.addListener('keyboardWillHide', () => set(0))
  void Keyboard.addListener('keyboardDidHide', () => set(0))
}
