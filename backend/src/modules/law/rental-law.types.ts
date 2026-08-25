export type RentalLawClause = {
  number: string;
  title: string | null;
  content: string;
  children: RentalLawClause[];
};
