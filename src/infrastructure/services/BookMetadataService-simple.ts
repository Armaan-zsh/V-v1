import axios from 'axios';

export interface BookMetadata {
  title?: string;
  author?: string;
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  language?: string;
  coverImage?: string;
  description?: string;
  isbn?: string;
  categories?: string[];
}

export interface PaperMetadata {
  title?: string;
  authors?: string[];
  journal?: string;
  publishedDate?: string;
  doi?: string;
  abstract?: string;
  arxivId?: string;
}

export class BookMetadataService {
  private readonly googleBooksApiKey?: string;

  constructor() {
    this.googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY;
  }

  async fetchBookByISBN(isbn: string): Promise<BookMetadata | null> {
    try {
      // Try Google Books API first
      if (this.googleBooksApiKey) {
        const book = await this.fetchFromGoogleBooks(isbn);
        if (book) return book;
      }

      // Fallback to Open Library (no API key needed)
      return await this.fetchFromOpenLibrary(isbn);
    } catch (error) {
      console.warn(`Failed to fetch book metadata for ISBN ${isbn}:`, error);
      return null;
    }
  }

  async fetchPaperByDOI(doi: string): Promise<PaperMetadata | null> {
    try {
      // Try CrossRef API (free, no auth needed)
      return await this.fetchFromCrossRef(doi);
    } catch (error) {
      console.warn(`Failed to fetch paper metadata for DOI ${doi}:`, error);
      return null;
    }
  }

  async searchBooks(query: string, limit: number = 10): Promise<BookMetadata[]> {
    try {
      if (this.googleBooksApiKey) {
        const results = await this.searchGoogleBooks(query, limit);
        if (results.length > 0) return results;
      }

      // Fallback to Open Library
      return await this.searchOpenLibrary(query, limit);
    } catch (error) {
      console.warn(`Failed to search books for query "${query}":`, error);
      return [];
    }
  }

  private async fetchFromGoogleBooks(isbn: string): Promise<BookMetadata | null> {
    const response = await axios.get(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&key=${this.googleBooksApiKey}`
    );

    if (!response.data.items || response.data.items.length === 0) {
      return null;
    }

    const volumeInfo = response.data.items[0].volumeInfo;
    return {
      title: volumeInfo.title,
      author: volumeInfo.authors ? volumeInfo.authors.join(', ') : undefined,
      publisher: volumeInfo.publisher,
      publishedDate: volumeInfo.publishedDate,
      pageCount: volumeInfo.pageCount,
      language: volumeInfo.language,
      coverImage: volumeInfo.imageLinks?.thumbnail,
      description: volumeInfo.description,
      categories: volumeInfo.categories,
      isbn
    };
  }

  private async fetchFromOpenLibrary(isbn: string): Promise<BookMetadata | null> {
    const response = await axios.get(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
    );

    if (!response.data[`ISBN:${isbn}`]) {
      return null;
    }

    const book = response.data[`ISBN:${isbn}`];
    return {
      title: book.title,
      author: book.authors?.[0]?.name,
      publisher: book.publishers?.[0]?.name,
      publishedDate: book.publish_date,
      pageCount: book.number_of_pages,
      coverImage: book.cover?.large,
      description: book.notes,
      isbn
    };
  }

  private async fetchFromCrossRef(doi: string): Promise<PaperMetadata | null> {
    const response = await axios.get(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    );

    if (!response.data.message) {
      return null;
    }

    const work = response.data.message;
    return {
      title: work.title?.[0],
      authors: work.author?.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()),
      journal: work['container-title']?.[0],
      publishedDate: work['published-print']?.['date-parts']?.[0]?.join('-'),
      doi: work.DOI,
      abstract: work.abstract
    };
  }

  private async searchGoogleBooks(query: string, limit: number): Promise<BookMetadata[]> {
    const response = await axios.get(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${limit}&key=${this.googleBooksApiKey}`
    );

    if (!response.data.items) {
      return [];
    }

    return response.data.items.map((item: any) => {
      const volumeInfo = item.volumeInfo;
      return {
        title: volumeInfo.title,
        author: volumeInfo.authors ? volumeInfo.authors.join(', ') : undefined,
        publisher: volumeInfo.publisher,
        publishedDate: volumeInfo.publishedDate,
        pageCount: volumeInfo.pageCount,
        language: volumeInfo.language,
        coverImage: volumeInfo.imageLinks?.thumbnail,
        description: volumeInfo.description,
        categories: volumeInfo.categories
      };
    });
  }

  private async searchOpenLibrary(query: string, limit: number): Promise<BookMetadata[]> {
    const response = await axios.get(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}`
    );

    if (!response.data.docs) {
      return [];
    }

    return response.data.docs.map((doc: any) => ({
      title: doc.title,
      author: doc.author_name?.[0],
      publishedDate: doc.first_publish_year?.toString(),
      coverImage: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
      categories: doc.subject?.slice(0, 5)
    }));
  }
}