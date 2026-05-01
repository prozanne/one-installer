import { useEffect, useState } from 'react';
import type { HostInfoResT } from '@shared/ipc-types';

/**
 * Sidebar banner that names the *machine the host is running on*.
 *
 * Visible always — but the styling is loud only in headless mode (the
 * remote-control case where the user is browsing into a Linux server
 * from a Windows desktop and needs an unmissable reminder of which
 * machine they're operating on). In local/Electron mode it's a quiet
 * one-line label so the chrome doesn't shout at the user.
 *
 * Picks an OS-specific tint so a quick glance distinguishes Linux /
 * Windows / macOS hosts without reading the label.
 */
export function HostBanner() {
  const [info, setInfo] = useState<HostInfoResT | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.vdxIpc.hostInfo();
        setInfo(r);
      } catch {
        /* preload not ready yet; HostBanner just doesn't render */
      }
    })();
  }, []);

  if (!info || !info.ok) return null;

  const platformIcon =
    info.platform === 'linux'
      ? '🐧'
      : info.platform === 'win32'
        ? '⊞'
        : info.platform === 'darwin'
          ? ''
          : '○';

  // Headless = remote control. Bold, OS-tinted, hostname front-and-center.
  if (info.headless) {
    const tint =
      info.platform === 'linux'
        ? 'bg-[#0F9488]/10 border-[#0F9488]/40 text-[#0F9488]'
        : info.platform === 'win32'
          ? 'bg-[#0078D4]/10 border-[#0078D4]/40 text-[#0078D4]'
          : 'bg-black/5 border-black/20 text-black/70';
    return (
      <div className={`mt-3 px-3 py-2 rounded-md border ${tint} text-xs font-mono`}>
        <div className="flex items-center gap-1.5 leading-none">
          <span className="text-base leading-none" aria-hidden>
            {platformIcon}
          </span>
          <span className="font-semibold uppercase tracking-wide text-[10px]">REMOTE</span>
        </div>
        <div className="mt-1 font-semibold truncate" title={info.hostname}>
          {info.hostname}
        </div>
        <div className="text-[10px] opacity-80 truncate" title={info.osLabel}>
          {info.osLabel}
        </div>
        <div className="text-[10px] opacity-60 truncate">{info.arch}</div>
      </div>
    );
  }

  // Local mode — quiet one-liner so it's there if you look.
  return (
    <div className="mt-3 px-3 py-1.5 text-[10px] font-mono text-black/40 truncate" title={info.osLabel}>
      <span aria-hidden className="mr-1">
        {platformIcon}
      </span>
      {info.osLabel}
    </div>
  );
}
