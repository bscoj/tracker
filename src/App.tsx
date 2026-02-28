import { useState, useEffect } from "react";
import {
  Dumbbell,
  Plus,
  Trash2,
  ChevronsUpDown,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { v4 as uuidv4 } from "uuid";
import type { Exercise, Set, Workout } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

const STORAGE_KEY_CURRENT = "ironlog_current";
const STORAGE_KEY_HISTORY = "ironlog_history";

function App() {
  const [currentWorkout, setCurrentWorkout] = useState<Workout | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
    return saved ? JSON.parse(saved) : null;
  });

  const [history, setHistory] = useState<Workout[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return parsed.filter(
      (w: Workout) => new Date(w.date).getTime() > thirtyDaysAgo,
    );
  });

  const [newExerciseName, setNewExerciseName] = useState("");
  const [newWeight, setNewWeight] = useState<number | "">("");
  const [newReps, setNewReps] = useState<number | "">("");
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [expandedExerciseId, setExpandedExerciseId] = useState<string | null>(
    null,
  );
  const [workoutName, setWorkoutName] = useState("");
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);

  // Exercise suggestions
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const commonExercises = [
    "Bench Press",
    "Incline Bench Press",
    "Decline Bench Press",
    "Dumbbell Bench Press",
    "Squat",
    "Front Squat",
    "Goblet Squat",
    "Leg Press",
    "Deadlift",
    "Romanian Deadlift",
    "Sumo Deadlift",
    "Overhead Press",
    "Arnold Press",
    "Barbell Row",
    "Dumbbell Row",
    "Pull-Up",
    "Lat Pulldown",
    "Bicep Curl",
    "Hammer Curl",
    "Tricep Extension",
    "Lateral Raise",
    "Face Pull",
    "Calf Raise",
  ];

  // Auto-save current workout
  useEffect(() => {
    if (currentWorkout) {
      localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(currentWorkout));
    } else {
      localStorage.removeItem(STORAGE_KEY_CURRENT);
    }
  }, [currentWorkout]);

  // Auto-save history
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  }, [history]);

  const startWorkout = () => {
    if (!currentWorkout) {
      const newWorkout: Workout = {
        id: uuidv4(),
        date: new Date().toISOString(),
        name: `Workout ${new Date().toLocaleDateString()}`,
        exercises: [],
      };
      setCurrentWorkout(newWorkout);
      setExpandedExerciseId(null);
    }
  };

  const addExercise = () => {
    if (!currentWorkout || !newExerciseName.trim() || !newWeight || !newReps)
      return;

    const newSet: Set = {
      id: uuidv4(),
      weight: Number(newWeight),
      reps: Number(newReps),
      completed: false,
    };

    const newExercise: Exercise = {
      id: uuidv4(),
      name: newExerciseName.trim(),
      sets: [newSet],
    };

    setCurrentWorkout({
      ...currentWorkout,
      exercises: [...currentWorkout.exercises, newExercise],
    });

    setNewExerciseName("");
    setNewWeight("");
    setNewReps("");
    setIsAddSheetOpen(false);
    setExpandedExerciseId(newExercise.id);
  };

  const addSetToExercise = (exerciseId: string) => {
    if (!currentWorkout) return;
    setCurrentWorkout({
      ...currentWorkout,
      exercises: currentWorkout.exercises.map((ex) =>
        ex.id === exerciseId
          ? {
              ...ex,
              sets: [
                ...ex.sets,
                { id: uuidv4(), weight: 135, reps: 8, completed: false },
              ],
            }
          : ex,
      ),
    });
  };

  const updateSet = (
    exerciseId: string,
    setIndex: number,
    field: "weight" | "reps",
    newValue: number,
  ) => {
    if (!currentWorkout) return;
    setCurrentWorkout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        exercises: prev.exercises.map((ex) =>
          ex.id === exerciseId
            ? {
                ...ex,
                sets: ex.sets.map((s, idx) =>
                  idx === setIndex ? { ...s, [field]: newValue } : s,
                ),
              }
            : ex,
        ),
      };
    });
  };

  const deleteSet = (exerciseId: string, setIndex: number) => {
    if (!currentWorkout) return;
    setCurrentWorkout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        exercises: prev.exercises
          .map((ex) =>
            ex.id === exerciseId
              ? { ...ex, sets: ex.sets.filter((_, i) => i !== setIndex) }
              : ex,
          )
          .filter((ex) => ex.sets.length > 0),
      };
    });
  };

  const finishWorkout = () => {
    if (!currentWorkout) return;

    const finalName =
      workoutName.trim() ||
      `Workout ${new Date(currentWorkout.date).toLocaleDateString()}`;

    const finishedWorkout = { ...currentWorkout, name: finalName };

    setHistory((prev) => [finishedWorkout, ...prev]);
    setCurrentWorkout(null);
    setWorkoutName("");
    setExpandedExerciseId(null);
    setIsFinishDialogOpen(false);
  };

  const startFromTemplate = (template: Workout) => {
    const newWorkout: Workout = {
      id: uuidv4(),
      date: new Date().toISOString(),
      name: `${template.name} (Template)`,
      exercises: template.exercises.map((ex) => ({
        ...ex,
        id: uuidv4(),
        sets: ex.sets.map((s) => ({
          ...s,
          id: uuidv4(),
          completed: false,
        })),
      })),
    };

    setCurrentWorkout(newWorkout);
    setExpandedExerciseId(newWorkout.exercises[0]?.id || null);
  };

  return (
    <div className="min-h-screen bg-background text-foreground pb-32">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Dumbbell className="h-8 w-8 text-emerald-500" />
            <h1 className="text-2xl font-bold tracking-tight">ironlog</h1>
          </div>
          <div className="flex items-center gap-3">
            {currentWorkout && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsFinishDialogOpen(true)}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Finish
              </Button>
            )}
            <div className="text-sm text-muted-foreground">Olathe, KS</div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-6">
        <Tabs defaultValue="today" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="today">
            {currentWorkout ? (
              <div className="space-y-4">
                {currentWorkout.exercises.map((ex) => {
                  const minReps = Math.min(...ex.sets.map((s) => s.reps));
                  const maxReps = Math.max(...ex.sets.map((s) => s.reps));
                  const repsSummary =
                    ex.sets.length > 0 ? `${minReps}-${maxReps}` : "0";

                  return (
                    <Card key={ex.id} className="border-border overflow-hidden">
                      <div
                        className="flex items-center justify-between px-6 py-5 cursor-pointer bg-secondary/30 hover:bg-secondary/50 transition-colors"
                        onClick={() =>
                          setExpandedExerciseId(
                            expandedExerciseId === ex.id ? null : ex.id,
                          )
                        }
                      >
                        <div>
                          <CardTitle className="text-xl">{ex.name}</CardTitle>
                          <p className="text-sm text-muted-foreground">
                            {ex.sets.length} sets • {repsSummary} reps
                          </p>
                        </div>
                        <ChevronsUpDown
                          className={`h-6 w-6 transition-transform ${expandedExerciseId === ex.id ? "rotate-180" : ""}`}
                        />
                      </div>

                      <Collapsible
                        open={expandedExerciseId === ex.id}
                        onOpenChange={(o) =>
                          setExpandedExerciseId(o ? ex.id : null)
                        }
                      >
                        <CollapsibleContent>
                          <CardContent className="pt-2 space-y-4">
                            {ex.sets.map((set, setIndex) => (
                              <div
                                key={set.id}
                                className="flex items-center gap-6 py-4 border-b border-border last:border-none"
                              >
                                <div className="flex-1">
                                  <div className="flex items-center gap-3">
                                    <Button
                                      variant="ghost"
                                      size="lg"
                                      className="h-14 w-14 text-3xl"
                                      onClick={() =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "weight",
                                          Math.max(0, set.weight - 1),
                                        )
                                      }
                                    >
                                      −
                                    </Button>
                                    <Input
                                      type="number"
                                      value={set.weight}
                                      className="h-16 text-5xl font-bold text-center flex-1 border-none bg-secondary/30 focus:bg-secondary/50 text-foreground"
                                      min={0}
                                      onChange={(e) =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "weight",
                                          Math.max(
                                            0,
                                            Number(e.target.value) || 0,
                                          ),
                                        )
                                      }
                                    />
                                    <Button
                                      variant="ghost"
                                      size="lg"
                                      className="h-14 w-14 text-3xl"
                                      onClick={() =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "weight",
                                          set.weight + 1,
                                        )
                                      }
                                    >
                                      +
                                    </Button>
                                  </div>
                                  <div className="text-center text-sm text-muted-foreground mt-2">
                                    Weight (lbs)
                                  </div>
                                </div>

                                <div className="flex-1">
                                  <div className="flex items-center gap-3">
                                    <Button
                                      variant="ghost"
                                      size="lg"
                                      className="h-14 w-14 text-3xl"
                                      onClick={() =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "reps",
                                          Math.max(0, set.reps - 1),
                                        )
                                      }
                                    >
                                      −
                                    </Button>
                                    <Input
                                      type="number"
                                      value={set.reps}
                                      className="h-16 text-5xl font-bold text-center flex-1 border-none bg-secondary/30 focus:bg-secondary/50 text-foreground"
                                      min={0}
                                      onChange={(e) =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "reps",
                                          Math.max(
                                            0,
                                            Number(e.target.value) || 0,
                                          ),
                                        )
                                      }
                                    />
                                    <Button
                                      variant="ghost"
                                      size="lg"
                                      className="h-14 w-14 text-3xl"
                                      onClick={() =>
                                        updateSet(
                                          ex.id,
                                          setIndex,
                                          "reps",
                                          set.reps + 1,
                                        )
                                      }
                                    >
                                      +
                                    </Button>
                                  </div>
                                  <div className="text-center text-sm text-muted-foreground mt-2">
                                    Reps
                                  </div>
                                </div>

                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-14 w-14 text-muted-foreground hover:text-destructive"
                                  onClick={() => deleteSet(ex.id, setIndex)}
                                >
                                  <Trash2 className="h-6 w-6" />
                                </Button>
                              </div>
                            ))}

                            <Button
                              variant="outline"
                              className="w-full py-8 text-lg font-medium"
                              onClick={() => addSetToExercise(ex.id)}
                            >
                              + Add Set
                            </Button>
                          </CardContent>
                        </CollapsibleContent>
                      </Collapsible>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-24 text-muted-foreground">
                No workout active.
                <br />
                Tap the + to start lifting!
              </div>
            )}
          </TabsContent>

          <TabsContent value="history">
            <div className="space-y-4">
              {history.length === 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>No workouts yet</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      Finish your first workout to see it here.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                history.map((workout) => (
                  <Card key={workout.id} className="border-border">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-lg">
                            {workout.name ||
                              `Workout ${new Date(workout.date).toLocaleDateString()}`}
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            {new Date(workout.date).toLocaleDateString()} •{" "}
                            {workout.exercises.length} exercises
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startFromTemplate(workout)}
                        >
                          Use as Template
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {workout.exercises.map((ex) => (
                          <li key={ex.id}>
                            {ex.name} • {ex.sets.length} sets
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* Finish Dialog */}
      <Dialog open={isFinishDialogOpen} onOpenChange={setIsFinishDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finish Workout</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Label htmlFor="workout-name">Workout Name</Label>
            <Input
              id="workout-name"
              placeholder="e.g. Push Day Heavy"
              value={workoutName}
              onChange={(e) => setWorkoutName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={finishWorkout}>Save & Finish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Exercise Sheet */}
      <Sheet open={isAddSheetOpen} onOpenChange={setIsAddSheetOpen}>
        <SheetTrigger asChild>
          <Button
            size="lg"
            className="fixed bottom-8 right-6 rounded-full w-16 h-16 shadow-2xl shadow-emerald-950/50 bg-emerald-600 hover:bg-emerald-500"
            onClick={startWorkout}
          >
            <Plus className="h-8 w-8" />
          </Button>
        </SheetTrigger>

        <SheetContent
          side="bottom"
          className="h-[75vh] max-w-2xl mx-auto rounded-t-3xl shadow-2xl border border-border bg-background"
        >
          <SheetHeader>
            <SheetTitle className="text-2xl">Add Exercise</SheetTitle>
          </SheetHeader>

          <div className="space-y-8 py-8">
            <div className="space-y-2">
              <Label>Exercise Name</Label>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full h-14 justify-between text-left text-lg font-medium"
                  >
                    {newExerciseName || "Tap to choose or search..."}
                    <ChevronsUpDown className="h-5 w-5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder="Search exercises..."
                      value={search}
                      onValueChange={setSearch} // ← this line uses setSearch
                      className="h-14 text-lg"
                    />
                    <CommandList className="max-h-80">
                      <CommandEmpty>
                        No match. Tap below to add custom.
                      </CommandEmpty>
                      <CommandGroup>
                        {commonExercises
                          .filter((ex) =>
                            ex.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map((ex) => (
                            <CommandItem
                              key={ex}
                              onSelect={() => {
                                setNewExerciseName(ex);
                                setOpen(false);
                              }}
                            >
                              {ex}
                            </CommandItem>
                          ))}
                        <CommandItem
                          onSelect={() => {
                            setOpen(false);
                            setTimeout(() => setNewExerciseName(""), 100);
                          }}
                          className="text-emerald-400 font-medium"
                        >
                          + Add custom exercise
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Starting Weight (lbs)</Label>
                <Input
                  type="number"
                  placeholder="225"
                  value={newWeight}
                  onChange={(e) =>
                    setNewWeight(e.target.value ? Number(e.target.value) : "")
                  }
                  className="h-14 text-2xl"
                />
              </div>
              <div className="space-y-2">
                <Label>Starting Reps</Label>
                <Input
                  type="number"
                  placeholder="8"
                  value={newReps}
                  onChange={(e) =>
                    setNewReps(e.target.value ? Number(e.target.value) : "")
                  }
                  className="h-14 text-2xl"
                />
              </div>
            </div>

            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700 h-14 text-lg"
              onClick={addExercise}
              disabled={!newExerciseName.trim() || !newWeight || !newReps}
            >
              Add to Workout
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default App;
