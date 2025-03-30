import TurndownService from "turndown";
import { decode } from "html-entities";

// Initialize turndown service with common configuration
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-",
  strongDelimiter: "**",
  linkStyle: "inlined",
  linkReferenceStyle: "full",
  br: "", // Replaces <br> with nothing, paragraphs handle breaks
  blankReplacement: (content) => "\n\n", // Ensures blank lines become paragraph breaks
});

/**
 * Converts HTML content to Markdown using a shared Turndown instance.
 * @param html The HTML string to convert.
 * @returns The converted Markdown string.
 */
const convertHtmlToMarkdown = (html: string): string => {
  // First decode entities, then convert to markdown
  const decodedHtml = decode(html);
  return turndownService.turndown(decodedHtml);
};

export { turndownService, convertHtmlToMarkdown };
