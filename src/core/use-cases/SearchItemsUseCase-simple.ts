import { z } from 'zod';
import { ItemType, ReadingStatus, ProfileVisibility } from '../../shared/types';
import { ItemRepository } from '../repositories/ItemRepository';
import { UserRepository } from '../repositories/UserRepository';

const SearchItemsSchema = z.object({
  query: z.string().optional(),
  type: z.nativeEnum(ItemType).optional(),
  status: z.nativeEnum(ReadingStatus).optional(),
  userId: z.string().cuid().optional(),
  publicOnly: z.boolean().default(true),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0)
});

export interface SearchResult {
  items: Array<{
    id: string;
    title: string;
    author?: string;
    type: ItemType;
    status: ReadingStatus;
    coverImage?: string;
    publishedYear?: number;
    rating?: number;
    user: {
      username: string;
      name?: string;
    };
    tags: string[];
  }>;
  total: number;
  hasMore: boolean;
}

export class SearchItemsUseCase {
  constructor(
    private readonly itemRepo: ItemRepository,
    private readonly userRepo: UserRepository
  ) {}

  async execute(input: z.infer<typeof SearchItemsSchema>): Promise<SearchResult> {
    const filters = SearchItemsSchema.parse(input);

    // Build search query
    const where: any = {};

    if (filters.query) {
      where.OR = [
        { title: { contains: filters.query, mode: 'insensitive' } },
        { author: { contains: filters.query, mode: 'insensitive' } }
      ];
    }

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.userId) {
      where.userId = filters.userId;
    }

    // Only show public items unless it's the user's own items
    if (filters.publicOnly) {
      where.isPublic = true;
      // Join with user to check profile visibility
      where.user = {
        profileVisibility: ProfileVisibility.PUBLIC
      };
    }

    if (filters.tags && filters.tags.length > 0) {
      where.tags = {
        some: {
          tag: {
            slug: { in: filters.tags }
          }
        }
      };
    }

    const [items, total] = await Promise.all([
      this.itemRepo.findMany({
        where,
        take: filters.limit + 1, // Take one extra to check if there are more
        skip: filters.offset,
        orderBy: { addedAt: 'desc' },
        include: {
          user: {
            select: {
              username: true,
              name: true,
              profileVisibility: true
            }
          },
          tags: {
            include: {
              tag: true
            }
          }
        }
      }),
      this.itemRepo.count({ where })
    ]);

    const hasMore = items.length > filters.limit;
    const itemsToReturn = hasMore ? items.slice(0, filters.limit) : items;

    return {
      items: itemsToReturn.map(item => ({
        id: item.id,
        title: item.title,
        author: item.author,
        type: item.type,
        status: item.status,
        coverImage: item.coverImage,
        publishedYear: item.publishedYear,
        rating: item.rating,
        user: {
          username: item.user.username,
          name: item.user.name
        },
        tags: item.tags.map(tag => tag.tag.name)
      })),
      total,
      hasMore
    };
  }
}