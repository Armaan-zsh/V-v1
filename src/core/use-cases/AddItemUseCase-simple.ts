import { z } from 'zod';
import { ItemType, ReadingStatus } from '../../shared/types';
import { BookMetadataService } from '../services/BookMetadataService';
import { UserRepository } from '../repositories/UserRepository';
import { ItemRepository } from '../repositories/ItemRepository';

const AddItemSchema = z.object({
  userId: z.string().cuid(),
  type: z.nativeEnum(ItemType),
  title: z.string().min(1).max(500),
  author: z.string().optional(),
  isbn: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  publishedYear: z.number().int().min(1000).max(new Date().getFullYear()).optional(),
  coverImage: z.string().url().optional(),
  status: z.nativeEnum(ReadingStatus).default(ReadingStatus.READ),
  notes: z.string().max(5000).optional(),
  readDate: z.date().optional()
});

export class AddItemUseCase {
  constructor(
    private readonly bookMetadata: BookMetadataService,
    private readonly userRepo: UserRepository,
    private readonly itemRepo: ItemRepository
  ) {}

  async execute(input: z.infer<typeof AddItemSchema>) {
    const data = AddItemSchema.parse(input);

    // Try to fetch metadata from external APIs (Google Books, CrossRef, ArXiv)
    let metadata = {};
    try {
      if (data.type === ItemType.BOOK && data.isbn) {
        const bookData = await this.bookMetadata.fetchBookByISBN(data.isbn);
        if (bookData) {
          metadata = { isbn: data.isbn, ...bookData };
        }
      } else if (data.type === ItemType.PAPER && data.doi) {
        const paperData = await this.bookMetadata.fetchPaperByDOI(data.doi);
        if (paperData) {
          metadata = { doi: data.doi, ...paperData };
        }
      }
    } catch (error) {
      console.warn('Failed to fetch metadata:', error);
      // Continue without metadata
    }

    // Create the item
    const item = await this.itemRepo.create({
      userId: data.userId,
      type: data.type,
      title: data.title,
      author: data.author,
      url: data.url,
      publishedYear: data.publishedYear,
      coverImage: data.coverImage,
      status: data.status,
      notes: data.notes,
      readDate: data.readDate,
      metadata
    });

    // Update user stats
    await this.userRepo.incrementItemCount(data.userId, data.type);

    return item;
  }
}