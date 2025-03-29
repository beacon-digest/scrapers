# Beacon Library Calendar Scraper Plan

## Overview
Create a Node.js script that scrapes event data from the Beacon Library calendar for a given date.

## Dependencies
- `puppeteer`: For browser automation and scraping dynamic content
- `date-fns`: For date manipulation and formatting
- `typescript`: For type safety and better developer experience
- `@types/node`: TypeScript definitions for Node.js
- `@types/puppeteer`: TypeScript definitions for Puppeteer

## Implementation Steps

1. **Setup Project**
   - Initialize Node.js project
   - Install required dependencies
   - Create TypeScript configuration (tsconfig.json)
   - Create main script file with .ts extension

2. **Type Definitions**
   ```typescript
   interface Event {
     title: string;
     start_at: string;
     end_at: string;
     location: string;
     description: string;
     url: string;
     external_id: string;
   }

   interface ScrapedEvents {
     events: Event[];
   }
   ```

3. **Main Script Structure**
   ```typescript
   // Main function to orchestrate the scraping process
   async function scrapeBeaconLibraryCalendar(targetDate: Date): Promise<ScrapedEvents> {
     const browser = await puppeteer.launch();
     try {
       // Implementation
     } finally {
       await browser.close();
     }
   }
   ```

4. **Calendar Page Scraping**
   - Launch Puppeteer browser
   - Navigate to calendar page
   - Wait for calendar content to load
   - Extract all event links for given date
   - Return array of event URLs

5. **Event Page Scraping**
   - For each event URL:
     - Open new page in browser
     - Wait for event content to load
     - Extract relevant event data:
       - Title
       - Date and time
       - Location
       - Description
       - Registration requirements
       - Any other relevant fields
     - Close event page

6. **Data Processing**
   - Format extracted data into consistent JSON structure
   - Handle missing or malformed data gracefully
   - Validate required fields

7. **Output**
   - Console.log formatted JSON for each event
   - Include error handling and logging

## Error Handling
- Handle browser launch/close errors
- Handle navigation timeouts
- Handle element not found errors
- Handle network errors
- Handle invalid dates
- Handle missing event data
- Implement retry logic for failed requests

## Usage Example
```typescript
// Example usage
const targetDate = new Date('2024-03-20');
scrapeBeaconLibraryCalendar(targetDate)
  .then((events: ScrapedEvents) => {
    console.log(JSON.stringify(events, null, 2));
  })
  .catch((error: Error) => {
    console.error('Scraping failed:', error);
  });
```

## Expected Output Format
```typescript
interface ScrapedEvents {
  events: Array<{
    title: string;
    start_at: string;
    end_at: string;
    location: string;
    description: string;
    url: string;
    external_id: string;
  }>;
}
```

## Notes
- Implement appropriate delays between requests to avoid overwhelming the server
- Consider adding rate limiting
- Add proper error handling and logging
- Consider adding data validation
- Use ISO 8601 format for timestamps with timezone offset
- Use headless mode for better performance
- Consider implementing page caching for development
- Extract external_id from the last segment of the event URL
- Use strict TypeScript configuration for better type safety
- Consider adding ESLint with TypeScript support 