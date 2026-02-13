import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { BackIcon } from '../Icons';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  currentProvider: string;
  cursorMode?: 'default' | 'plan' | 'ask';
  onCursorModeSelect?: (mode: 'default' | 'plan' | 'ask') => void;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

export function ChatHeader({
  currentView,
  sessionTitle,
  currentProvider,
  cursorMode = 'default',
  onCursorModeSelect,
  t,
  onBack,
  onNewSession,
  onNewTab,
  onHistory,
  onSettings,
}: ChatHeaderProps): React.ReactElement | null {
  const [cursorMenuOpen, setCursorMenuOpen] = useState(false);
  const cursorMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cursorMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (cursorMenuRef.current && !cursorMenuRef.current.contains(e.target as Node)) {
        setCursorMenuOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [cursorMenuOpen]);

  if (currentView === 'settings') {
    return null;
  }

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            <BackIcon /> {t('common.back')}
          </button>
        ) : (
          <div
            className="session-title"
            style={{
              fontWeight: 600,
              fontSize: '14px',
              paddingLeft: '8px',
            }}
          >
            {sessionTitle}
          </div>
        )}
        {currentView === 'chat' && currentProvider === 'cursor' && (
          <div
            className={`cursor-mode-badge-wrapper ${cursorMenuOpen ? 'open' : ''}`}
            ref={cursorMenuRef}
          >
            <button
              className="cursor-mode-badge"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCursorMenuOpen((open) => !open);
              }}
              title={t('chat.cursorModeBadgeTitle', { defaultValue: 'Cursor 执行模式' })}
            >
              {t('chat.cursorModeBadgePrefix', { defaultValue: 'Cursor' })} · {t(`chat.cursorModeBadge.${cursorMode}`, {
                defaultValue: cursorMode === 'plan' ? '规划' : cursorMode === 'ask' ? '问答' : '默认',
              })}
            </button>
            <div className="cursor-mode-badge-menu">
              {(['default', 'plan', 'ask'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`cursor-mode-badge-item ${mode === cursorMode ? 'selected' : ''}`}
                  onClick={() => {
                    onCursorModeSelect?.(mode);
                    setCursorMenuOpen(false);
                  }}
                >
                  {t(`chat.cursorModeBadge.${mode}`, {
                    defaultValue: mode === 'plan' ? '规划' : mode === 'ask' ? '问答' : '默认',
                  })}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')}>
              <span className="codicon codicon-plus" />
            </button>
            <button
              className="icon-button"
              onClick={onNewTab}
              data-tooltip={t('common.newTab')}
            >
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
            >
              <span className="codicon codicon-history" />
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
            >
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
