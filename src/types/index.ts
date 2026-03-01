export interface Set {
  id: string;
  weight: number;
  reps: number;
  completed: boolean;
}

export interface Exercise {
  id: string;
  name: string;
  sets: Set[];
}

export type SessionContext = "great" | "normal" | "fatigued" | "rushed";

export interface Workout {
  id: string;
  date: string; // ISO date string
  name: string; // ← required name field
  exercises: Exercise[];
  contextTag?: SessionContext;
}

export type WorkoutHistory = Workout[];
