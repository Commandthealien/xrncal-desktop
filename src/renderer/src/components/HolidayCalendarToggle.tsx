import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2 } from 'lucide-react'
import type { Calendar } from '@shared/event-model'
import { HOLIDAY_CALENDAR_META, type HolidayCalendarType } from '@shared/holiday-calendars'

interface HolidayCalendarToggleProps {
  calendars: Calendar[]
  onCalendarsChanged: () => void
}

export const HolidayCalendarToggle: React.FC<HolidayCalendarToggleProps> = ({
  calendars,
  onCalendarsChanged
}) => {
  const { t } = useTranslation()
  const [loadingType, setLoadingType] = useState<HolidayCalendarType | null>(null)

  const isVietnamSubscribed = calendars.some((c) => c.name === HOLIDAY_CALENDAR_META.vietnam.name)
  const isInternationalSubscribed = calendars.some(
    (c) => c.name === HOLIDAY_CALENDAR_META.international.name
  )

  const handleToggle = async (type: HolidayCalendarType) => {
    if (!window.xrncal?.holidays) return
    setLoadingType(type)

    try {
      const isSubscribed = type === 'vietnam' ? isVietnamSubscribed : isInternationalSubscribed
      if (isSubscribed) {
        await window.xrncal.holidays.unsubscribe(type)
      } else {
        await window.xrncal.holidays.subscribe(type)
      }
      onCalendarsChanged()
    } catch {
      // The row keeps showing the state it was in.
    } finally {
      setLoadingType(null)
    }
  }

  return (
    <div className="space-y-1 select-none">
      {/* Vietnam Holidays */}
      <div
        onClick={() => handleToggle('vietnam')}
        className={`flex items-center justify-between px-2 py-1.5 rounded-[4px] border text-xs cursor-pointer transition-colors ${
          isVietnamSubscribed
            ? 'bg-accent/10 border-accent/30 text-primary'
            : 'bg-surface border-hairline text-muted hover:bg-hover hover:text-primary'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm shrink-0">🇻🇳</span>
          <span className="font-medium text-xs truncate">{t('holidays.vietnam')}</span>
        </div>

        <div className="shrink-0 flex items-center">
          {loadingType === 'vietnam' ? (
            <Loader2 className="h-3 w-3 text-accent animate-spin" />
          ) : isVietnamSubscribed ? (
            <span className="px-1.5 py-0.5 rounded-[3px] bg-accent/20 text-accent text-[10px] font-medium flex items-center gap-0.5">
              <Check className="h-2.5 w-2.5" /> {t('common.on')}
            </span>
          ) : (
            <span className="text-[10px] text-muted hover:text-primary font-medium">{t('holidays.enable')}</span>
          )}
        </div>
      </div>

      {/* International Holidays */}
      <div
        onClick={() => handleToggle('international')}
        className={`flex items-center justify-between px-2 py-1.5 rounded-[4px] border text-xs cursor-pointer transition-colors ${
          isInternationalSubscribed
            ? 'bg-accent/10 border-accent/30 text-primary'
            : 'bg-surface border-hairline text-muted hover:bg-hover hover:text-primary'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm shrink-0">🌐</span>
          <span className="font-medium text-xs truncate">{t('holidays.international')}</span>
        </div>

        <div className="shrink-0 flex items-center">
          {loadingType === 'international' ? (
            <Loader2 className="h-3 w-3 text-accent animate-spin" />
          ) : isInternationalSubscribed ? (
            <span className="px-1.5 py-0.5 rounded-[3px] bg-accent/20 text-accent text-[10px] font-medium flex items-center gap-0.5">
              <Check className="h-2.5 w-2.5" /> {t('common.on')}
            </span>
          ) : (
            <span className="text-[10px] text-muted hover:text-primary font-medium">{t('holidays.enable')}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default HolidayCalendarToggle
