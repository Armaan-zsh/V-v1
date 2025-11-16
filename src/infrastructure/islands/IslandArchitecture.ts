import { useState, useEffect, Suspense, lazy } from 'react';
import { DynamicHydrationProvider } from './DynamicHydrationProvider';

// Island component interfaces
export interface IslandProps {
  fallback?: React.ReactNode;
  priority?: 'high' | 'low';
  data?: any;
  clientOnly?: boolean;
}

export interface IslandConfig {
  name: string;
  component: React.ComponentType<any>;
  fallback?: React.ReactNode;
  priority: 'high' | 'low' | 'critical';
  hydrateOn?: 'mount' | 'visible' | 'idle' | 'interaction';
  ssr?: boolean;
}

// Base Island component with dynamic hydration
export function Island<T extends IslandProps>(
  config: IslandConfig,
  props: Omit<T, keyof IslandProps>
): JSX.Element {
  const { component: Component, fallback, priority, hydrateOn, ssr } = config;
  
  return (
    <DynamicHydrationProvider 
      component={Component}
      fallback={fallback}
      priority={priority}
      hydrateOn={hydrateOn}
      ssr={ssr}
      {...props}
    />
  );
}

// Critical islands that hydrate immediately
export const CriticalIslands = {
  // Navigation menu - critical for UX
  Navigation: (props: any) => (
    <Island
      config={{
        name: 'Navigation',
        component: NavigationIsland,
        priority: 'critical',
        hydrateOn: 'mount',
        ssr: true
      }}
      {...props}
    />
  ),

  // User profile menu - critical for authenticated users
  UserMenu: (props: any) => (
    <Island
      config={{
        name: 'UserMenu',
        component: UserMenuIsland,
        priority: 'critical',
        hydrateOn: 'mount',
        ssr: true
      }}
      {...props}
    />
  ),

  // Search bar - critical for discovery
  SearchBar: (props: any) => (
    <Island
      config={{
        name: 'SearchBar',
        component: SearchBarIsland,
        priority: 'critical',
        hydrateOn: 'mount',
        ssr: true
      }}
      {...props}
    />
  )
};

// High priority islands that hydrate when visible
export const HighPriorityIslands = {
  // Reading progress - important for engagement
  ReadingProgress: (props: any) => (
    <Island
      config={{
        name: 'ReadingProgress',
        component: ReadingProgressIsland,
        priority: 'high',
        hydrateOn: 'visible',
        ssr: false
      }}
      {...props}
    />
  ),

  // Recommendations - important for retention
  RecommendationFeed: (props: any) => (
    <Island
      config={{
        name: 'RecommendationFeed',
        component: RecommendationFeedIsland,
        priority: 'high',
        hydrateOn: 'visible',
        ssr: false
      }}
      {...props}
    />
  ),

  // Notifications - important for user awareness
  NotificationCenter: (props: any) => (
    <Island
      config={{
        name: 'NotificationCenter',
        component: NotificationCenterIsland,
        priority: 'high',
        hydrateOn: 'visible',
        ssr: false
      }}
      {...props}
    />
  )
};

// Low priority islands that hydrate on idle or interaction
export const LowPriorityIslands = {
  // Activity feed - lower priority
  ActivityFeed: (props: any) => (
    <Island
      config={{
        name: 'ActivityFeed',
        component: ActivityFeedIsland,
        priority: 'low',
        hydrateOn: 'idle',
        ssr: false
      }}
      {...props}
    />
  ),

  // Reading statistics - lower priority
  ReadingStats: (props: any) => (
    <Island
      config={{
        name: 'ReadingStats',
        component: ReadingStatsIsland,
        priority: 'low',
        hydrateOn: 'idle',
        ssr: false
      }}
      {...props}
    />
  ),

  // Social features - lower priority
  SocialShare: (props: any) => (
    <Island
      config={{
        name: 'SocialShare',
        component: SocialShareIsland,
        priority: 'low',
        hydrateOn: 'interaction',
        ssr: false
      }}
      {...props}
    />
  )
};

// Lazy-loaded island components
const NavigationIsland = lazy(() => import('../components/islands/NavigationIsland'));
const UserMenuIsland = lazy(() => import('../components/islands/UserMenuIsland'));
const SearchBarIsland = lazy(() => import('../components/islands/SearchBarIsland'));
const ReadingProgressIsland = lazy(() => import('../components/islands/ReadingProgressIsland'));
const RecommendationFeedIsland = lazy(() => import('../components/islands/RecommendationFeedIsland'));
const NotificationCenterIsland = lazy(() => import('../components/islands/NotificationCenterIsland'));
const ActivityFeedIsland = lazy(() => import('../components/islands/ActivityFeedIsland'));
const ReadingStatsIsland = lazy(() => import('../components/islands/ReadingStatsIsland'));
const SocialShareIsland = lazy(() => import('../components/islands/SocialShareIsland'));

// Island hydration manager
export class IslandHydrationManager {
  private static instance: IslandHydrationManager;
  private hydrationQueue: Map<string, () => void> = new Map();
  private observer: IntersectionObserver | null = null;
  private idleCallback: typeof window.requestIdleCallback | null = null;
  private isInitialized = false;

  private constructor() {
    this.initializeHydration();
  }

  static getInstance(): IslandHydrationManager {
    if (!IslandHydrationManager.instance) {
      IslandHydrationManager.instance = new IslandHydrationManager();
    }
    return IslandHydrationManager.instance;
  }

  private initializeHydration(): void {
    if (typeof window === 'undefined') return;

    // Setup Intersection Observer for 'visible' hydration
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const islandName = entry.target.getAttribute('data-island');
              if (islandName) {
                this.hydrateIsland(islandName);
              }
            }
          });
        },
        {
          rootMargin: '50px',
          threshold: 0.1
        }
      );
    }

    // Setup idle callback for 'idle' hydration
    if ('requestIdleCallback' in window) {
      this.idleCallback = window.requestIdleCallback;
    } else {
      this.idleCallback = (callback) => setTimeout(callback, 1);
    }

    this.isInitialized = true;
  }

  /**
   * Register island for hydration
   */
  register(islandName: string, hydrateFn: () => void): void {
    this.hydrationQueue.set(islandName, hydrateFn);

    // If observer is available and hydration is 'visible', observe the element
    if (this.observer) {
      const element = document.querySelector(`[data-island="${islandName}"]`);
      if (element) {
        this.observer.observe(element);
      }
    }
  }

  /**
   * Hydrate specific island
   */
  hydrateIsland(islandName: string): void {
    const hydrateFn = this.hydrationQueue.get(islandName);
    if (hydrateFn) {
      hydrateFn();
      this.hydrationQueue.delete(islandName);

      // Stop observing if it was a visible hydration
      if (this.observer) {
        const element = document.querySelector(`[data-island="${islandName}"]`);
        if (element) {
          this.observer.unobserve(element);
        }
      }
    }
  }

  /**
   * Hydrate all high-priority islands
   */
  hydrateHighPriority(): void {
    const highPriorityIslands = ['Navigation', 'UserMenu', 'SearchBar'];
    
    highPriorityIslands.forEach(islandName => {
      if (this.hydrationQueue.has(islandName)) {
        this.hydrateIsland(islandName);
      }
    });
  }

  /**
   * Schedule low-priority islands for idle hydration
   */
  scheduleIdleHydration(): void {
    if (this.idleCallback) {
      this.idleCallback(() => {
        ['ActivityFeed', 'ReadingStats', 'SocialShare'].forEach(islandName => {
          if (this.hydrationQueue.has(islandName)) {
            this.hydrateIsland(islandName);
          }
        });
      });
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.hydrationQueue.clear();
  }
}

// Hook for dynamic component loading
export function useIslandHydration(islandName: string, priority: 'high' | 'low') {
  const [isHydrated, setIsHydrated] = useState(false);
  const manager = IslandHydrationManager.getInstance();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    manager.register(islandName, () => setIsHydrated(true));

    // High priority islands hydrate immediately on mount
    if (priority === 'high' && !isHydrated) {
      manager.hydrateIsland(islandName);
    }

    return () => {
      manager.hydrateIsland(islandName);
    };
  }, [islandName, priority]);

  return { isHydrated, hydrate: () => manager.hydrateIsland(islandName) };
}

// Server-side rendering optimization
export function getIslandProps(islandName: string, props?: any) {
  // Return minimal props for SSR
  const baseProps = {
    'Navigation': { user: null, isAuthenticated: false },
    'UserMenu': { user: null, notifications: [] },
    'SearchBar': { query: '', suggestions: [] },
    'ReadingProgress': { progress: 0, bookId: null },
    'RecommendationFeed': { recommendations: [] },
    'NotificationCenter': { notifications: [], unread: 0 },
    'ActivityFeed': { activities: [], loading: true },
    'ReadingStats': { stats: null, loading: true },
    'SocialShare': { url: '', title: '' }
  };

  return { ...baseProps[islandName], ...props };
}

// Lazy loading utilities
export function lazyLoad<T extends React.ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  options?: {
    fallback?: React.ComponentType;
    preload?: boolean;
  }
) {
  const LazyComponent = lazy(importFn);

  return function LazyLoadedComponent(props: React.ComponentProps<T>) {
    const { fallback: Fallback } = options || {};
    
    return (
      <Suspense fallback={Fallback ? <Fallback /> : <div>Loading...</div>}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

// Preload critical islands
export function preloadCriticalIslands(): void {
  if (typeof window === 'undefined') return;

  // Preload critical island components
  const criticalImports = [
    () => import('../components/islands/NavigationIsland'),
    () => import('../components/islands/UserMenuIsland'),
    () => import('../components/islands/SearchBarIsland')
  ];

  criticalImports.forEach(importFn => {
    importFn().catch(console.error);
  });
}

// Analytics for island performance
export function trackIslandHydration(islandName: string, timing: number): void {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag('event', 'island_hydration', {
      island_name: islandName,
      timing_ms: timing,
      event_category: 'performance'
    });
  }
}

// Export all island types
export type {
  IslandProps,
  IslandConfig
};