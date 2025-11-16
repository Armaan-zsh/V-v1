/**
 * Add Item Use Case - Core business logic for adding reading items
 * Implements clean architecture with input validation and event emission
 */

import { z } from 'zod';
import { Item, ItemType } from '../entities/Item';
import { UserId } from '../entities/User';
import { IItemRepository } from '../repositories/IItemRepository';
import { IUserRepository } from '../repositories/IUserRepository';
import { 
  ValidationError, 
  NotFoundError, 
  RateLimitError, 
  BusinessRuleError,
  zodToValidationError,
  createNotFoundError
} from '../../shared/types/errors';

// Input DTO schema
export const AddItemSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  title: z.string().min(1, 'Title is required').max(500, 'Title cannot exceed 500 characters'),
  type: z.enum(['BOOK', 'PAPER', 'ARTICLE'] as const),
  author: z.string().max(500, 'Author cannot exceed 500 characters').optional(),
  url: z.string().url('Invalid URL format').optional(),
  isbn: z.string().optional(),
  doi: z.string().optional(),
  publishedYear: z.number().int().min(1400).max(new Date().getFullYear() + 1).optional(),
  status: z.enum(['WANT_TO_READ', 'READING', 'READ', 'SKIMMED'] as const).default('READ'),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(5000, 'Notes cannot exceed 5000 characters').optional(),
  readDate: z.date().optional(),
  isPublic: z.boolean().default(true),
  tags: z.array(z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    color: z.string()
  })).max(10, 'Cannot have more than 10 tags').optional(),
  metadata: z.record(z.any()).optional()
});

export type AddItemInput = z.infer<typeof AddItemSchema>;

// Output DTO
export interface AddItemOutput {
  item: {
    id: string;
    type: ItemType;
    title: string;
    author?: string;
    url?: string;
    coverImage?: string;
    publishedYear?: number;
    status: string;
    rating?: number;
    notes?: string;
    readDate?: Date;
    isPublic: boolean;
    tags: Array<{
      id: string;
      name: string;
      slug: string;
      color: string;
    }>;
    metadata: Record<string, any>;
    addedAt: Date;
  };
  events: DomainEvent[];
}

// Domain events
export interface DomainEvent {
  type: 'ItemAddedEvent';
  data: {
    itemId: string;
    userId: string;
    type: ItemType;
    timestamp: Date;
  };
}

export interface ItemAddedEvent extends DomainEvent {
  type: 'ItemAddedEvent';
  data: {
    itemId: string;
    userId: string;
    type: ItemType;
    timestamp: Date;
  };
}

export interface UserStatsUpdatedEvent extends DomainEvent {
  type: 'UserStatsUpdatedEvent';
  data: {
    userId: string;
    newStats: {
      totalItems: number;
      booksCount: number;
      papersCount: number;
      articlesCount: number;
    };
    timestamp: Date;
  };
}

/**
 * Rate limiter interface for use case-level rate limiting
 */
export interface IRateLimiter {
  checkRateLimit(key: string, limit: number, windowMs: number): Promise<void>;
}

/**
 * Event emitter interface for domain events
 */
export interface IDomainEventEmitter {
  emit(event: DomainEvent): Promise<void>;
}

/**
 * Add Item Use Case
 * Orchestrates the process of adding a new reading item
 */
export class AddItemUseCase {
  constructor(
    private readonly itemRepository: IItemRepository,
    private readonly userRepository: IUserRepository,
    private readonly rateLimiter: IRateLimiter,
    private readonly eventEmitter: IDomainEventEmitter
  ) {}

  /**
   * Execute the add item use case
   */
  async execute(input: AddItemInput): Promise<AddItemOutput> {
    // 1. Validate input with Zod
    const validatedInput = AddItemSchema.safeParse(input);
    if (!validatedInput.success) {
      throw zodToValidationError(validatedInput.error);
    }

    const { userId, ...itemData } = validatedInput.data;

    // 2. Check if user exists
    const user = await this.userRepository.findById(userId as UserId);
    if (!user) {
      throw createNotFoundError('User', userId);
    }

    // 3. Rate limiting check - 10 items per minute per user
    const rateLimitKey = `user:${userId}:add_item`;
    await this.rateLimiter.checkRateLimit(rateLimitKey, 10, 60 * 1000);

    // 4. Validate ISBN format if provided
    if (itemData.isbn && !this.isValidISBN(itemData.isbn)) {
      throw new ValidationError('Invalid ISBN format', 'isbn', itemData.isbn, 'format');
    }

    // 5. Validate DOI format if provided
    if (itemData.doi && !this.isValidDOI(itemData.doi)) {
      throw new ValidationError('Invalid DOI format', 'doi', itemData.doi, 'format');
    }

    // 6. Validate read date is not in the future
    if (itemData.readDate && itemData.readDate > new Date()) {
      throw new ValidationError('Read date cannot be in the future', 'readDate', itemData.readDate, 'future_date');
    }

    // 7. Check for duplicate items (same title + author + user)
    const existingItems = await this.itemRepository.findByUserId(
      userId as UserId,
      { limit: 100, cursor: undefined, sort: { field: 'addedAt', direction: 'desc' } }
    );
    
    const isDuplicate = existingItems.items.some(item =>
      item.getTitle().toLowerCase() === itemData.title.toLowerCase() &&
      (item.getAuthor()?.toLowerCase() || '') === (itemData.author?.toLowerCase() || '') &&
      item.getType() === itemData.type
    );

    if (isDuplicate) {
      throw new BusinessRuleError(
        'You have already added this item',
        'duplicate_item',
        { title: itemData.title, author: itemData.author, type: itemData.type }
      );
    }

    // 8. Create Item entity
    const item = Item.create({
      userId: userId as UserId,
      type: itemData.type,
      title: itemData.title,
      author: itemData.author,
      url: itemData.url,
      publishedYear: itemData.publishedYear,
      status: itemData.status,
      rating: itemData.rating,
      notes: itemData.notes,
      readDate: itemData.readDate,
      isPublic: itemData.isPublic,
      tags: itemData.tags,
      metadata: {
        ...itemData.metadata,
        ...(itemData.isbn && { isbn: itemData.isbn }),
        ...(itemData.doi && { doi: itemData.doi }),
      }
    });

    // 9. Persist the item
    await this.itemRepository.create(item);

    // 10. Update user statistics
    const oldStats = user.getStats();
    const updatedUser = user.updateStatsForNewItem(itemData.type);
    
    await this.userRepository.updateStats(userId as UserId, {
      totalItems: oldStats.totalItems + 1,
      booksCount: oldStats.booksCount + (itemData.type === 'BOOK' ? 1 : 0),
      papersCount: oldStats.papersCount + (itemData.type === 'PAPER' ? 1 : 0),
      articlesCount: oldStats.articlesCount + (itemData.type === 'ARTICLE' ? 1 : 0),
      lastReadDate: itemData.readDate || updatedUser.getLastReadDate()
    });

    // 11. Emit domain events
    const events: DomainEvent[] = [];

    // ItemAddedEvent
    const itemAddedEvent: ItemAddedEvent = {
      type: 'ItemAddedEvent',
      data: {
        itemId: item.getId(),
        userId: userId as string,
        type: itemData.type,
        timestamp: new Date()
      }
    };
    events.push(itemAddedEvent);
    await this.eventEmitter.emit(itemAddedEvent);

    // UserStatsUpdatedEvent
    const newStats = updatedUser.getStats();
    const statsUpdatedEvent: UserStatsUpdatedEvent = {
      type: 'UserStatsUpdatedEvent',
      data: {
        userId: userId as string,
        newStats: {
          totalItems: newStats.totalItems,
          booksCount: newStats.booksCount,
          papersCount: newStats.papersCount,
          articlesCount: newStats.articlesCount
        },
        timestamp: new Date()
      }
    };
    events.push(statsUpdatedEvent);
    await this.eventEmitter.emit(statsUpdatedEvent);

    // 12. Schedule metadata fetch if ISBN/DOI provided
    if (itemData.isbn || itemData.doi) {
      const metadataFetchEvent: DomainEvent = {
        type: 'MetadataFetchRequestedEvent',
        data: {
          itemId: item.getId(),
          userId: userId as string,
          isbn: itemData.isbn,
          doi: itemData.doi,
          timestamp: new Date()
        }
      };
      events.push(metadataFetchEvent);
      await this.eventEmitter.emit(metadataFetchEvent);
    }

    // 13. Return result
    return {
      item: item.toPlainObject(),
      events
    };
  }

  /**
   * Validate ISBN format
   */
  private isValidISBN(isbn: string): boolean {
    // Remove hyphens and spaces
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    
    // Check length - ISBN-10 or ISBN-13
    if (cleanIsbn.length === 10) {
      return this.isValidISBN10(cleanIsbn);
    } else if (cleanIsbn.length === 13) {
      return this.isValidISBN13(cleanIsbn);
    }
    
    return false;
  }

  /**
   * Validate ISBN-10 format
   */
  private isValidISBN10(isbn: string): boolean {
    if (!/^\d{9}[\dX]$/.test(isbn)) return false;
    
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(isbn[i]) * (10 - i);
    }
    const checkDigit = isbn[9] === 'X' ? 10 : parseInt(isbn[9]);
    sum += checkDigit;
    
    return sum % 11 === 0;
  }

  /**
   * Validate ISBN-13 format
   */
  private isValidISBN13(isbn: string): boolean {
    if (!/^\d{13}$/.test(isbn)) return false;
    
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(isbn[i]);
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    
    return checkDigit === parseInt(isbn[12]);
  }

  /**
   * Validate DOI format
   */
  private isValidDOI(doi: string): boolean {
    // DOI pattern: 10.<prefix>/<suffix>
    const doiPattern = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
    return doiPattern.test(doi);
  }
}

/**
 * Mock implementations for testing and development
 */
export class MockRateLimiter implements IRateLimiter {
  private requests = new Map<string, { count: number; resetTime: number }>();

  async checkRateLimit(key: string, limit: number, windowMs: number): Promise<void> {
    const now = Date.now();
    const current = this.requests.get(key);

    if (!current || now > current.resetTime) {
      this.requests.set(key, { count: 1, resetTime: now + windowMs });
      return;
    }

    if (current.count >= limit) {
      const retryAfter = Math.ceil((current.resetTime - now) / 1000);
      throw new RateLimitError(
        `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
        limit
      );
    }

    current.count++;
  }
}

export class MockEventEmitter implements IDomainEventEmitter {
  private events: DomainEvent[] = [];

  async emit(event: DomainEvent): Promise<void> {
    this.events.push(event);
    // In a real implementation, this would publish to a message queue
    console.log(`Event emitted: ${event.type}`, event.data);
  }

  getEmittedEvents(): DomainEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
