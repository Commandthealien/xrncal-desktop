import React from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, X } from 'lucide-react'

interface KeyboardShortcutsModalProps {
  isOpen: boolean
  onClose: () => void
}

interface Shortcut {
  /** One entry per interchangeable way of pressing it; drawn as separate keycaps. */
  keys: string[]
  description: string
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose
}) => {
  const { t } = useTranslation()
  if (!isOpen) return null

  const groups: { title: string; shortcuts: Shortcut[] }[] = [
    {
      title: t('shortcuts.navGroup'),
      shortcuts: [
        { keys: ['T'], description: t('shortcuts.goToday') },
        { keys: ['←', 'K', 'PgUp'], description: t('shortcuts.prevPeriod') },
        { keys: ['→', 'J', 'PgDn'], description: t('shortcuts.nextPeriod') }
      ]
    },
    {
      title: t('shortcuts.viewsGroup'),
      shortcuts: [
        { keys: ['1', 'D'], description: t('shortcuts.dayView') },
        { keys: ['2', 'W'], description: t('shortcuts.weekView') },
        { keys: ['3', 'M'], description: t('shortcuts.monthView') },
        { keys: ['4', 'Y'], description: t('shortcuts.yearView') },
        { keys: ['5', 'L'], description: t('shortcuts.listView') }
      ]
    },
    {
      title: t('shortcuts.selectionGroup'),
      shortcuts: [
        { keys: ['↓'], description: t('shortcuts.nextEvent') },
        { keys: ['↑'], description: t('shortcuts.prevEvent') },
        { keys: ['Enter'], description: t('shortcuts.openEvent') },
        { keys: ['Del', '⌫'], description: t('shortcuts.deleteEvent') },
        { keys: ['Esc'], description: t('shortcuts.clearSelection') }
      ]
    },
    {
      title: t('shortcuts.moveGroup'),
      shortcuts: [
        { keys: ['Shift + ↑', 'Shift + ↓'], description: t('shortcuts.moveByStep') },
        { keys: ['Shift + ←', 'Shift + →'], description: t('shortcuts.moveByDay') },
        { keys: ['Alt + ↑', 'Alt + ↓'], description: t('shortcuts.resizeByStep') }
      ]
    },
    {
      title: t('shortcuts.editorGroup'),
      shortcuts: [
        { keys: ['Enter'], description: t('shortcuts.saveFromTitle') },
        { keys: ['Ctrl + Enter'], description: t('shortcuts.saveEvent') },
        { keys: ['Ctrl + ⌫'], description: t('shortcuts.deleteEditorEvent') },
        { keys: ['Esc'], description: t('shortcuts.closeEditor') },
        { keys: ['↑', '↓'], description: t('shortcuts.pickerMove') },
        { keys: ['Enter'], description: t('shortcuts.pickerPick') },
        { keys: ['PgUp', 'PgDn'], description: t('shortcuts.pickerMonth') },
        { keys: ['T'], description: t('shortcuts.pickerToday') }
      ]
    },
    {
      title: t('shortcuts.actionsGroup'),
      shortcuts: [
        { keys: ['N', 'C'], description: t('shortcuts.createEvent') },
        { keys: ['Ctrl + K', '/'], description: t('shortcuts.searchPalette') },
        { keys: ['Ctrl + B'], description: t('shortcuts.toggleSidebar') },
        { keys: ['R'], description: t('shortcuts.syncNow') },
        { keys: [','], description: t('shortcuts.openSettings') },
        { keys: ['?'], description: t('shortcuts.openShortcuts') },
        { keys: ['Esc'], description: t('shortcuts.closeDialog') }
      ]
    }
  ]

  return (
    <div className="gc-overlay select-none">
      <div className="gc-dialog w-full max-w-3xl">
        <div className="flex items-center justify-between border-b border-hairline bg-app px-6 py-4">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-accent" />
            <h3 className="text-sm font-semibold text-primary">{t('shortcuts.title')}</h3>
          </div>
          <button type="button" onClick={onClose} className="gc-icon-btn">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Two columns: the sheet is long enough now that one would scroll past
            the fold on any laptop. */}
        <div className="grid gap-x-8 gap-y-5 overflow-y-auto p-6 max-h-[70vh] sm:grid-cols-2">
          {groups.map((grp) => (
            <div key={grp.title} className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted">{grp.title}</h4>
              <div className="grid gap-1.5">
                {grp.shortcuts.map((s) => (
                  <div
                    key={s.description}
                    className="flex items-center justify-between gap-3 rounded-[3px] border border-hairline bg-app px-2 py-1.5 text-xs"
                  >
                    <span className="min-w-0 font-medium text-primary">{s.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k, i) => (
                        <React.Fragment key={k}>
                          {i > 0 && (
                            <span className="text-[10px] text-muted">{t('shortcuts.orKey')}</span>
                          )}
                          <kbd className="rounded-[3px] border border-hairline bg-hover px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent">
                            {k}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-hairline bg-app px-6 py-3">
          <button type="button" onClick={onClose} className="gc-btn-primary">
            {t('common.gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default KeyboardShortcutsModal
