package dev.minecraftcli.control;

public final class VirtualCursor {
  private static volatile boolean active;
  private static volatile double x;
  private static volatile double y;

  private VirtualCursor() {}

  public static void set(double rawX, double rawY) {
    x = rawX;
    y = rawY;
    active = true;
  }

  public static void clear() { active = false; }
  public static boolean active() { return active; }
  public static double x() { return x; }
  public static double y() { return y; }
}
