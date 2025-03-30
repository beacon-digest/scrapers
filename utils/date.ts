import { format as formatFn, eachDayOfInterval } from "date-fns";

/**
 * Formats a date object into 'yyyy-MM-dd' string format.
 * @param date The date to format.
 * @returns The formatted date string.
 */
export const formatDate = (date: Date): string => {
  return formatFn(date, "yyyy-MM-dd");
};

/**
 * Generates an array of dates within a given interval (inclusive).
 * If endDate is not provided, it defaults to startDate, returning an array with a single date.
 * @param startDate The start date of the interval.
 * @param endDate The end date of the interval (optional).
 * @returns An array of Date objects.
 */
export const getDatesInRange = (startDate: Date, endDate?: Date): Date[] => {
  const finalEndDate = endDate ?? startDate;

  if (startDate > finalEndDate) {
    throw new Error(
      `Start date (${formatDate(
        startDate
      )}) cannot be after end date (${formatDate(finalEndDate)})`
    );
  }

  return eachDayOfInterval({ start: startDate, end: finalEndDate });
};
