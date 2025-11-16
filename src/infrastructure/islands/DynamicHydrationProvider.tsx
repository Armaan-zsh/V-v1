import React, { Suspense, useEffect, useState } from 'react';
import { IslandHydrationManager, useIslandHydration, trackIslandHydration } from './IslandArchitecture';

interface DynamicHydrationProviderProps {
  component: React.ComponentType<any>;
  fallback?: React.ReactNode;
  priority?: 'high' | 'low';
  hydrateOn?: 'mount' | 'visible' | 'idle' | 'interaction';
  ssr?: boolean;
  [key: string]: any;
}

export function DynamicHydrationProvider({
  component: Component,
  fallback = null,
  priority = 'low',
  hydrateOn = 'idle',
  ssr = true,
  ...props
}: DynamicHydrationProviderProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [startTime] = useState(Date.now());

  // Generate unique island ID
  const islandId = `island-${Component.displayName || Component.name || 'unknown'}`;

  // Get island hydration manager
  const manager = IslandHydrationManager.getInstance();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Determine hydration strategy
    const shouldHydrate = () => {
      switch (hydrateOn) {
        case 'mount':
          return true;
        case 'visible':
          return isElementVisible(islandId);
        case 'idle':
          return !document.hidden && !document.querySelector(':focus-within');
        case 'interaction':
          return false; // Hydrate on first user interaction
        default:
          return false;
      }
    };

    // Register with hydration manager
    manager.register(islandId, () => {
      setIsHydrated(true);
      
      // Track performance
      const timing = Date.now() - startTime;
      trackIslandHydration(islandId, timing);
    });

    // Auto-hydrate based on strategy
    if (shouldHydrate()) {
      manager.hydrateIsland(islandId);
    }

    // Set up interaction-based hydration
    if (hydrateOn === 'interaction') {
      const handleInteraction = () => {
        manager.hydrateIsland(islandId);
        // Remove listeners after first interaction
        document.removeEventListener('click', handleInteraction);
        document.removeEventListener('keydown', handleInteraction);
        document.removeEventListener('scroll', handleInteraction);
      };

      document.addEventListener('click', handleInteraction, { once: true });
      document.addEventListener('keydown', handleInteraction, { once: true });
      document.addEventListener('scroll', handleInteraction, { once: true });
    }

    return () => {
      // Cleanup when component unmounts
      const element = document.querySelector(`[data-island="${islandId}"]`);
      if (element) {
        // Observer cleanup happens in IslandHydrationManager
      }
    };
  }, [hydrateOn, islandId, manager]);

  // For server-side rendering or non-hydrated state
  if (!isHydrated && !ssr) {
    return (
      <div data-island={islandId} className="island-loading">
        {fallback}
      </div>
    );
  }

  return (
    <div data-island={islandId} data-priority={priority} data-hydrate={hydrateOn}>
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    </div>
  );
}

/**
 * Check if element is visible in viewport
 */
function isElementVisible(elementId: string): boolean {
  const element = document.querySelector(`[data-island="${elementId}"]`);
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
  const windowWidth = window.innerWidth || document.documentElement.clientWidth;

  // Check if element is in viewport
  return (
    rect.top <= windowHeight &&
    rect.bottom >= 0 &&
    rect.left <= windowWidth &&
    rect.right >= 0
  );
}

/**
 * Hydrate specific island with retry logic
 */
export async function hydrateIslandWithRetry(
  islandId: string, 
  maxRetries: number = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const manager = IslandHydrationManager.getInstance();
      manager.hydrateIsland(islandId);
      return true;
    } catch (error) {
      console.error(`Hydration attempt ${attempt} failed for ${islandId}:`, error);
      
      if (attempt === maxRetries) {
        // Show error fallback
        const element = document.querySelector(`[data-island="${islandId}"]`);
        if (element) {
          element.innerHTML = '<div class="island-error">Failed to load content</div>';
        }
        return false;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return false;
}

/**
 * Batch hydrate multiple islands for efficiency
 */
export function batchHydrateIslands(islandIds: string[]): void {
  const manager = IslandHydrationManager.getInstance();
  
  // Use requestAnimationFrame for batch updates
  requestAnimationFrame(() => {
    islandIds.forEach(id => manager.hydrateIsland(id));
  });
}

/**
 * Create portal islands that render outside normal DOM hierarchy
 */
export function PortalIsland({
  component: Component,
  portalId,
  ...props
}: {
  component: React.ComponentType<any>;
  portalId: string;
} & DynamicHydrationProviderProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return null;
  }

  return (
    <DynamicHydrationProvider
      component={Component}
      hydrateOn="interaction"
      {...props}
    />
  );
}

/**
 * Stream island that renders progressively
 */
export function StreamIsland({
  component: Component,
  dataChunks,
  renderChunk,
  ...props
}: {
  component: React.ComponentType<any>;
  dataChunks: any[];
  renderChunk: (chunk: any, index: number) => React.ReactNode;
} & DynamicHydrationProviderProps) {
  const [hydratedChunks, setHydratedChunks] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setHydratedChunks(prev => {
        if (prev < dataChunks.length) {
          return prev + 1;
        }
        clearInterval(interval);
        return prev;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [dataChunks.length]);

  return (
    <div>
      {dataChunks.slice(0, hydratedChunks).map((chunk, index) => (
        <div key={index}>
          {renderChunk(chunk, index)}
        </div>
      ))}
      {hydratedChunks < dataChunks.length && (
        <div className="streaming-indicator">
          Loading more...
        </div>
      )}
    </div>
  );
}