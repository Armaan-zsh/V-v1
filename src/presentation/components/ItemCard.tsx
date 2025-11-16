/**
 * ItemCard Component - Displays reading items in grid/list views
 * 90s brutalist design with neon borders and monospace fonts
 */

'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';

interface ItemCardProps extends VariantProps<typeof cardVariants> {
  item: {
    id: string;
    title: string;
    author?: string;
    type: 'BOOK' | 'PAPER' | 'ARTICLE';
    coverImage?: string;
    publishedYear?: number;
    status: 'WANT_TO_READ' | 'READING' | 'READ' | 'SKIMMED';
    rating?: number;
    notes?: string;
    tags?: Array<{
      id: string;
      name: string;
      slug: string;
      color: string;
    }>;
    readDate?: Date;
    addedAt: Date;
  };
  onEdit?: () => void;
  onClick?: () => void;
  className?: string;
}

/**
 * Card variant styles using CVA
 */
const cardVariants = cva(
  // Base styles - 90s brutalist
  [
    'relative bg-white border-4 border-black font-mono text-black',
    'transform transition-all duration-200 cursor-pointer',
    'hover:scale-[1.02] active:scale-[0.98]',
  ],
  {
    variants: {
      variant: {
        grid: [
          'w-full max-w-sm rounded-none shadow-lg',
          'hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]',
        ],
        list: [
          'w-full rounded-none shadow-md',
          'hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]',
        ],
      },
      status: {
        'WANT_TO_READ': 'border-cyan-400 hover:border-cyan-500',
        'READING': 'border-yellow-400 hover:border-yellow-500',
        'READ': 'border-green-400 hover:border-green-500',
        'SKIMMED': 'border-purple-400 hover:border-purple-500',
      },
    },
    defaultVariants: {
      variant: 'grid',
      status: 'READ',
    },
  }
);

/**
 * Type badge component
 */
const TypeBadge: React.FC<{ type: 'BOOK' | 'PAPER' | 'ARTICLE' }> = ({ type }) => {
  const styles = {
    BOOK: 'bg-blue-500 text-white',
    PAPER: 'bg-green-500 text-white',
    ARTICLE: 'bg-orange-500 text-white',
  };

  return (
    <span className={clsx(
      'inline-block px-2 py-1 text-xs font-bold uppercase tracking-wide',
      styles[type]
    )}>
      {type.toLowerCase()}
    </span>
  );
};

/**
 * Rating stars component
 */
const RatingStars: React.FC<{ rating: number }> = ({ rating }) => {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={clsx(
            'text-lg',
            star <= rating ? 'text-yellow-400' : 'text-gray-300'
          )}
        >
          ★
        </span>
      ))}
    </div>
  );
};

/**
 * Cover image component with lazy loading
 */
const CoverImage: React.FC<{ 
  src?: string; 
  title: string;
  className?: string;
}> = ({ src, title, className }) => {
  const [imageError, setImageError] = React.useState(false);
  const [imageLoaded, setImageLoaded] = React.useState(false);

  const placeholder = `data:image/svg+xml;base64,${btoa(`
    <svg width="200" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="300" fill="#f3f4f6"/>
      <text x="100" y="150" text-anchor="middle" fill="#6b7280" font-family="monospace" font-size="12">
        ${title.substring(0, 20)}${title.length > 20 ? '...' : ''}
      </text>
    </svg>
  `)}`;

  return (
    <div className={clsx('relative overflow-hidden bg-gray-100', className)}>
      {!imageError && src ? (
        <motion.img
          src={src}
          alt={title}
          className="w-full h-full object-cover"
          onError={() => setImageError(true)}
          onLoad={() => setImageLoaded(true)}
          initial={{ opacity: 0 }}
          animate={{ opacity: imageLoaded ? 1 : 0 }}
          transition={{ duration: 0.3 }}
          loading="lazy"
        />
      ) : (
        <img
          src={placeholder}
          alt={title}
          className="w-full h-full object-cover opacity-60"
        />
      )}
      
      {!imageLoaded && src && !imageError && (
        <div className="absolute inset-0 bg-gray-200 animate-pulse" />
      )}
    </div>
  );
};

/**
 * Main ItemCard component
 */
export const ItemCard: React.FC<ItemCardProps> = ({
  item,
  variant = 'grid',
  status = 'READ',
  onEdit,
  onClick,
  className,
}) => {
  const handleCardClick = () => {
    if (onClick) {
      onClick();
    }
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) {
      onEdit();
    }
  };

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(date));
  };

  return (
    <motion.div
      className={clsx(cardVariants({ variant, status }), className)}
      onClick={handleCardClick}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      {/* Edit button */}
      {onEdit && (
        <button
          onClick={handleEditClick}
          className="absolute top-2 right-2 z-10 p-1 bg-black text-white hover:bg-gray-800 transition-colors"
          aria-label="Edit item"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
      )}

      {/* Grid layout */}
      {variant === 'grid' && (
        <div className="flex flex-col h-full">
          {/* Cover Image */}
          <CoverImage
            src={item.coverImage}
            title={item.title}
            className="w-full h-48 flex-shrink-0"
          />

          {/* Content */}
          <div className="flex-1 p-4 space-y-3">
            {/* Title and Type */}
            <div className="space-y-2">
              <h3 className="text-sm font-bold leading-tight line-clamp-2">
                {item.title}
              </h3>
              <TypeBadge type={item.type} />
            </div>

            {/* Author */}
            {item.author && (
              <p className="text-xs text-gray-600 line-clamp-1">
                by {item.author}
              </p>
            )}

            {/* Published Year */}
            {item.publishedYear && (
              <p className="text-xs text-gray-500">
                {item.publishedYear}
              </p>
            )}

            {/* Status */}
            <div className="flex items-center justify-between">
              <span className={clsx(
                'text-xs font-bold px-2 py-1 uppercase tracking-wide',
                {
                  'bg-cyan-100 text-cyan-800': item.status === 'WANT_TO_READ',
                  'bg-yellow-100 text-yellow-800': item.status === 'READING',
                  'bg-green-100 text-green-800': item.status === 'READ',
                  'bg-purple-100 text-purple-800': item.status === 'SKIMMED',
                }
              )}>
                {item.status.replace('_', ' ').toLowerCase()}
              </span>

              {item.rating && (
                <RatingStars rating={item.rating} />
              )}
            </div>

            {/* Tags */}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag.id}
                    className="text-xs px-2 py-1 bg-gray-100 border border-gray-300 hover:bg-gray-200 transition-colors"
                    style={{ borderColor: tag.color }}
                  >
                    {tag.name}
                  </span>
                ))}
                {item.tags.length > 3 && (
                  <span className="text-xs px-2 py-1 text-gray-500">
                    +{item.tags.length - 3} more
                  </span>
                )}
              </div>
            )}

            {/* Read Date */}
            {item.readDate && (
              <p className="text-xs text-gray-500">
                Read {formatDate(item.readDate)}
              </p>
            )}
          </div>
        </div>
      )}

      {/* List layout */}
      {variant === 'list' && (
        <div className="flex gap-4 p-4">
          {/* Cover Image */}
          <CoverImage
            src={item.coverImage}
            title={item.title}
            className="w-16 h-20 flex-shrink-0"
          />

          {/* Content */}
          <div className="flex-1 space-y-2">
            {/* Title and Type */}
            <div className="flex items-start justify-between">
              <h3 className="text-sm font-bold leading-tight line-clamp-2 flex-1">
                {item.title}
              </h3>
              <TypeBadge type={item.type} />
            </div>

            {/* Author and Year */}
            <div className="flex items-center gap-2 text-xs text-gray-600">
              {item.author && <span>by {item.author}</span>}
              {item.publishedYear && (
                <>
                  <span>•</span>
                  <span>{item.publishedYear}</span>
                </>
              )}
            </div>

            {/* Status, Rating, and Date */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={clsx(
                  'text-xs font-bold px-2 py-1 uppercase tracking-wide',
                  {
                    'bg-cyan-100 text-cyan-800': item.status === 'WANT_TO_READ',
                    'bg-yellow-100 text-yellow-800': item.status === 'READING',
                    'bg-green-100 text-green-800': item.status === 'READ',
                    'bg-purple-100 text-purple-800': item.status === 'SKIMMED',
                  }
                )}>
                  {item.status.replace('_', ' ').toLowerCase()}
                </span>

                {item.rating && (
                  <RatingStars rating={item.rating} />
                )}
              </div>

              {item.readDate && (
                <span className="text-xs text-gray-500">
                  {formatDate(item.readDate)}
                </span>
              )}
            </div>

            {/* Tags */}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.tags.slice(0, 5).map((tag) => (
                  <span
                    key={tag.id}
                    className="text-xs px-2 py-1 bg-gray-100 border border-gray-300"
                    style={{ borderColor: tag.color }}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Added timestamp */}
      <div className="absolute bottom-1 right-1 text-xs text-gray-400">
        {formatDate(item.addedAt)}
      </div>
    </motion.div>
  );
};

/**
 * ItemCard with error boundary
 */
export const ItemCardWithErrorBoundary: React.FC<ItemCardProps> = (props) => {
  return (
    <ErrorBoundary
      fallback={({ error }) => (
        <div className="p-4 bg-red-50 border-2 border-red-200 text-red-800 font-mono">
          <p className="text-sm font-bold">Error loading item</p>
          <p className="text-xs mt-1">{error.message}</p>
        </div>
      )}
    >
      <ItemCard {...props} />
    </ErrorBoundary>
  );
};

/**
 * Error Boundary Component
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ComponentType<{ error: Error; resetError: () => void }>;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ItemCard Error:', error, errorInfo);
  }

  resetError = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      const FallbackComponent = this.props.fallback;
      return (
        <FallbackComponent 
          error={this.state.error} 
          resetError={this.resetError} 
        />
      );
    }

    return this.props.children;
  }
}
