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

export interface Workout {
  id: string;
  date: string; // ISO date string
  name: string; // ← required name field
  exercises: Exercise[];
}

export type WorkoutHistory = Workout[];