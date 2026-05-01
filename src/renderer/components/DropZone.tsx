import { useState, useCallback } from 'react';

export function DropZone({ onPick }: { onPick: (path: string) => void }) {
  const [hover, setHover] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setHover(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const path = (file as unknown as { path?: string }).path;
      if (path) onPick(path);
    },
    [onPick],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
      className={`mt-6 border-2 border-dashed rounded-xl p-10 text-center transition ${
        hover ? 'border-teal bg-teal/5' : 'border-black/10 bg-white'
      }`}
    >
      <div className="font-medium mb-1">Drop a .vdxpkg here</div>
      <div className="text-sm text-black/50">
        or click "Open package..." to pick a file
      </div>
    </div>
  );
}
