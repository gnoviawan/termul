import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';

type ScrollContainerProps = {
  children: ReactNode;
  onScrollTopChange: (scrollTop: number) => void;
};

const scrollContainerClassName =
  'h-screen bg-black text-white selection:bg-white/30 font-sans';

function subscribeToClientMount() {
  return () => {};
}

function getClientMountSnapshot() {
  return true;
}

function getServerMountSnapshot() {
  return false;
}

export function ScrollContainer({ children, onScrollTopChange }: ScrollContainerProps) {
  const useOverlayScrollbars = useSyncExternalStore(
    subscribeToClientMount,
    getClientMountSnapshot,
    getServerMountSnapshot,
  );

  const overlayEvents = useMemo(
    () => ({
      initialized: (instance: OverlayScrollbars) => {
        onScrollTopChange(instance.elements().scrollOffsetElement.scrollTop);
      },
      scroll: (instance: OverlayScrollbars) => {
        onScrollTopChange(instance.elements().scrollOffsetElement.scrollTop);
      },
    }),
    [onScrollTopChange],
  );

  if (!useOverlayScrollbars) {
    return (
      <div className={`${scrollContainerClassName} overflow-y-auto`}>
        {children}
      </div>
    );
  }

  return (
    <OverlayScrollbarsComponent
      className={scrollContainerClassName}
      defer
      events={overlayEvents}
      options={{
        scrollbars: {
          autoHide: 'move',
          theme: 'os-theme-termul',
        },
      }}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}
