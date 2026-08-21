package dev.minecraftcli.control;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.ActiveTextCollector;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import dev.minecraftcli.control.mixin.ChatScreenAccessor;
import org.lwjgl.glfw.GLFW;

public final class MinecraftCliControlClient implements ClientModInitializer {
  private static final Gson GSON = new Gson();
  private Minecraft client;
  private String token;

  @Override
  public void onInitializeClient() {
    client = Minecraft.getInstance();
    JsonObject config = readConfig();
    token = config.has("token") ? config.get("token").getAsString() : "";
    int port = config.has("port") ? config.get("port").getAsInt() : 0;
    if (token.isBlank() || port < 1) return;
    try {
      HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
      server.createContext("/health", exchange -> respond(exchange, 200, state()));
      server.createContext("/state", exchange -> respondAuthorized(exchange, this::state));
      server.createContext("/screen/close", exchange -> respondAuthorized(exchange, () -> onClient(() -> {
        if (client.screen != null) client.screen.onClose();
        else client.setScreen(null);
        VirtualCursor.clear();
      })));
      server.createContext("/screen/chat", exchange -> respondAuthorized(exchange, this::openChat));
      server.createContext("/screen/click-slot", exchange -> respondAuthorized(exchange, () -> clickSlot(queryInt(exchange, "slot"))));
      server.createContext("/screen/hover-slot", exchange -> respondAuthorized(exchange, () -> hoverSlot(queryInt(exchange, "slot"))));
      server.createContext("/screen/hover-chat", exchange -> respondAuthorized(exchange, () -> hoverChat(queryInt(exchange, "line"))));
      server.createContext("/screen/click", exchange -> respondAuthorized(exchange, this::clickVirtual));
      server.createContext("/screen/move-cursor", exchange -> respondAuthorized(exchange, () -> moveCursor(queryInt(exchange, "x"), queryInt(exchange, "y"))));
      server.createContext("/screen/click-at", exchange -> respondAuthorized(exchange, () -> clickAt(queryInt(exchange, "x"), queryInt(exchange, "y"), queryInt(exchange, "button"))));
      server.createContext("/screen/elements", exchange -> respondAuthorized(exchange, this::screenElements));
      server.createContext("/screen/click-element", exchange -> respondAuthorized(exchange, () -> targetElement(queryRequired(exchange, "text"), queryIntDefault(exchange, "index", 0), queryBoolean(exchange, "exact"), true)));
      server.createContext("/screen/hover-element", exchange -> respondAuthorized(exchange, () -> targetElement(queryRequired(exchange, "text"), queryIntDefault(exchange, "index", 0), queryBoolean(exchange, "exact"), false)));
      server.createContext("/screen/actions", exchange -> respondAuthorized(exchange, this::screenActions));
      server.createContext("/screen/click-action", exchange -> respondAuthorized(exchange, () -> clickAction(query(exchange, "actionId"), queryIntDefault(exchange, "index", -1))));
      server.createContext("/world/entities", exchange -> respondAuthorized(exchange, this::worldEntities));
      server.createContext("/world/interact-role", exchange -> respondAuthorized(exchange, () -> interactRole(queryRequired(exchange, "role"), queryIntDefault(exchange, "index", 0), queryDoubleDefault(exchange, "maxDistance", 8))));
      server.createContext("/screen/type", exchange -> respondAuthorized(exchange, () -> typeText(queryRequired(exchange, "text"))));
      server.createContext("/screen/key", exchange -> respondAuthorized(exchange, () -> pressKey(queryRequired(exchange, "key"), queryIntDefault(exchange, "modifiers", 0))));
      server.createContext("/screen/scroll", exchange -> respondAuthorized(exchange, () -> scroll(queryDouble(exchange, "delta"))));
      server.createContext("/screenshot", exchange -> respondAuthorized(exchange, () -> screenshot(exchange)));
      server.setExecutor(Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "minecraft-cli-control-http");
        thread.setDaemon(true);
        return thread;
      }));
      server.start();
      if (config.has("serverHost") && config.has("serverPort")) {
        String host = config.get("serverHost").getAsString();
        int serverPort = config.get("serverPort").getAsInt();
        client.execute(() -> {
          String address = host + ":" + serverPort;
          ServerData data = new ServerData("minecraft-cli", address, ServerData.Type.OTHER);
          ConnectScreen.startConnecting(client.screen, client, new ServerAddress(host, serverPort), data, false, null);
        });
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not start minecraft-cli control server", error);
    }
  }

  private JsonObject readConfig() {
    try {
      Path file = Path.of("minecraft-cli-control.json").toAbsolutePath().normalize();
      if (!Files.exists(file)) return new JsonObject();
      return GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), JsonObject.class);
    } catch (Exception error) {
      throw new IllegalStateException("Could not read minecraft-cli-control.json", error);
    }
  }

  private JsonObject state() {
    JsonObject result = ok();
    result.addProperty("version", "1.21.11");
    result.addProperty("screen", client.screen == null ? "game" : client.screen.getClass().getName());
    result.addProperty("connected", client.getConnection() != null);
    result.addProperty("guiWidth", client.getWindow().getGuiScaledWidth());
    result.addProperty("guiHeight", client.getWindow().getGuiScaledHeight());
    JsonObject capabilities = new JsonObject();
    capabilities.addProperty("npcRoleInteraction", true);
    capabilities.addProperty("screenActions", true);
    capabilities.addProperty("nativeDialog", true);
    capabilities.addProperty("framebuffer", true);
    result.add("capabilities", capabilities);
    if (VirtualCursor.active()) {
      JsonObject cursor = new JsonObject();
      cursor.addProperty("x", VirtualCursor.x());
      cursor.addProperty("y", VirtualCursor.y());
      result.add("virtualCursor", cursor);
    }
    if (client.player != null) result.addProperty("player", client.getUser().getName());
    return result;
  }

  private JsonObject clickSlot(int slot) throws Exception {
    return onClient(() -> {
      if (!(client.screen instanceof AbstractContainerScreen<?> screen)) throw new IllegalStateException("No container screen is open");
      if (slot < 0 || slot >= screen.getMenu().slots.size()) throw new IllegalArgumentException("Invalid slot " + slot);
      if (client.gameMode == null || client.player == null) throw new IllegalStateException("Player is not ready");
      client.gameMode.handleInventoryMouseClick(screen.getMenu().containerId, slot, 0, ClickType.PICKUP, client.player);
      JsonObject result = ok();
      result.addProperty("slot", slot);
      return result;
    });
  }

  private JsonObject openChat() throws Exception {
    return onClient(() -> {
      if (client.player == null || client.getConnection() == null) throw new IllegalStateException("Player is not connected");
      client.setScreen(new ChatScreen("", false));
    });
  }

  private JsonObject screenshot(HttpExchange exchange) throws Exception {
    String rawPath = query(exchange, "path");
    if (rawPath == null || rawPath.isBlank()) throw new IllegalArgumentException("path is required");
    Path output = Path.of(rawPath).toAbsolutePath().normalize();
    Files.createDirectories(output.getParent());
    return onClient(() -> {
      Path gameDirectory = output.getParent().getParent();
      Path generated = gameDirectory.resolve("screenshots").resolve(output.getFileName());
      Screenshot.grab(gameDirectory.toFile(), output.getFileName().toString(), client.getMainRenderTarget(), 1, component -> {});
      for (int attempt = 0; attempt < 100 && !Files.exists(generated); attempt++) {
        try { Thread.sleep(10); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
      }
      if (Files.exists(generated)) Files.move(generated, output, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      JsonObject result = ok();
      result.addProperty("file", output.toString());
      result.addProperty("width", client.getWindow().getWidth());
      result.addProperty("height", client.getWindow().getHeight());
      return result;
    });
  }

  private JsonObject hoverSlot(int slot) throws Exception {
    return onClient(() -> {
      if (!(client.screen instanceof AbstractContainerScreen<?> screen)) throw new IllegalStateException("No container screen is open");
      if (slot < 0 || slot >= screen.getMenu().slots.size()) throw new IllegalArgumentException("Invalid slot " + slot);
      var target = screen.getMenu().getSlot(slot);
      int guiWidth = client.getWindow().getGuiScaledWidth();
      int guiHeight = client.getWindow().getGuiScaledHeight();
      double guiX = (guiWidth - 176) / 2.0 + target.x + 8;
      double guiY = (guiHeight - 166) / 2.0 + target.y + 8;
      double scaleX = (double) client.getWindow().getScreenWidth() / guiWidth;
      double scaleY = (double) client.getWindow().getScreenHeight() / guiHeight;
      double rawX = guiX * scaleX;
      double rawY = guiY * scaleY;
      VirtualCursor.set(rawX, rawY);
      JsonObject result = ok();
      result.addProperty("slot", slot);
      result.addProperty("x", guiX);
      result.addProperty("y", guiY);
      return result;
    });
  }

  private JsonObject onClient(ThrowingRunnable action) throws Exception {
    return onClient(() -> { action.run(); return ok(); });
  }

  private JsonObject hoverChat(int line) throws Exception {
    return onClient(() -> {
      if (!(client.screen instanceof ChatScreen)) throw new IllegalStateException("Chat screen is not open");
      int guiWidth = client.getWindow().getGuiScaledWidth();
      int guiHeight = client.getWindow().getGuiScaledHeight();
      double guiX = 220;
      double guiY = guiHeight - 44 - Math.max(0, line) * 9;
      double scale = client.getWindow().getGuiScale();
      VirtualCursor.set(guiX * scale, guiY * scale);
      JsonObject result = ok();
      result.addProperty("line", line);
      result.addProperty("x", guiX);
      result.addProperty("y", guiY);
      return result;
    });
  }

  private JsonObject clickVirtual() throws Exception {
    return onClient(() -> {
      if (client.screen == null || !VirtualCursor.active()) throw new IllegalStateException("No screen or virtual cursor");
      double scale = client.getWindow().getGuiScale();
      double x = VirtualCursor.x() / scale;
      double y = VirtualCursor.y() / scale;
      boolean handled;
      if (client.screen instanceof ChatScreen chatScreen) {
        var finder = new ActiveTextCollector.ClickableStyleFinder(client.font, (int) x, (int) y).includeInsertions(true);
        client.gui.getChat().captureClickableText(finder, client.getWindow().getGuiScaledHeight(), client.gui.getGuiTicks(), true);
        var style = finder.result();
        handled = style != null && ((ChatScreenAccessor) (Object) chatScreen).minecraftCliHandleComponentClicked(style, false);
      } else {
        handled = client.screen.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(0, 0)), false);
      }
      JsonObject result = ok();
      result.addProperty("handled", handled);
      return result;
    });
  }

  private JsonObject moveCursor(int x, int y) throws Exception {
    return onClient(() -> {
      int width = client.getWindow().getGuiScaledWidth();
      int height = client.getWindow().getGuiScaledHeight();
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new IllegalArgumentException("Coordinates outside GUI bounds " + width + "x" + height);
      }
      double scale = client.getWindow().getGuiScale();
      VirtualCursor.set(x * scale, y * scale);
      JsonObject result = state();
      result.addProperty("x", x);
      result.addProperty("y", y);
      result.addProperty("guiWidth", width);
      result.addProperty("guiHeight", height);
      return result;
    });
  }

  private JsonObject clickAt(int x, int y, int button) throws Exception {
    if (button < 0 || button > 2) throw new IllegalArgumentException("button must be 0, 1, or 2");
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      int width = client.getWindow().getGuiScaledWidth();
      int height = client.getWindow().getGuiScaledHeight();
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new IllegalArgumentException("Coordinates outside GUI bounds " + width + "x" + height);
      }
      double scale = client.getWindow().getGuiScale();
      VirtualCursor.set(x * scale, y * scale);
      boolean handled = client.screen.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)), false);
      JsonObject result = state();
      result.addProperty("x", x);
      result.addProperty("y", y);
      result.addProperty("button", button);
      result.addProperty("handled", handled);
      return result;
    });
  }

  private JsonObject screenElements() throws Exception {
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      JsonObject result = state();
      result.addProperty("title", client.screen.getTitle().getString());
      JsonArray elements = new JsonArray();
      int index = 0;
      for (var child : client.screen.children()) {
        if (child instanceof AbstractWidget widget) elements.add(widgetSummary(widget, index));
        index++;
      }
      result.add("elements", elements);
      return result;
    });
  }

  private JsonObject targetElement(String text, int requestedIndex, boolean exact, boolean click) throws Exception {
    if (requestedIndex < 0) throw new IllegalArgumentException("index must be non-negative");
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      int matched = 0;
      int childIndex = 0;
      for (var child : client.screen.children()) {
        if (child instanceof AbstractWidget widget && widget.visible && widget.active && textMatches(widget.getMessage().getString(), text, exact)) {
          if (matched++ == requestedIndex) {
            double x = widget.getX() + widget.getWidth() / 2.0;
            double y = widget.getY() + widget.getHeight() / 2.0;
            double scale = client.getWindow().getGuiScale();
            VirtualCursor.set(x * scale, y * scale);
            boolean handled = !click || client.screen.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(0, 0)), false);
            JsonObject result = state();
            result.add("element", widgetSummary(widget, childIndex));
            result.addProperty("handled", handled);
            return result;
          }
        }
        childIndex++;
      }
      throw new IllegalArgumentException("No active visible element matched: " + text);
    });
  }

  private JsonObject screenActions() throws Exception {
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      JsonObject result = state();
      result.addProperty("title", client.screen.getTitle().getString());
      JsonArray actions = new JsonArray();
      int childIndex = 0;
      int actionIndex = 0;
      for (var child : client.screen.children()) {
        if (child instanceof AbstractButton button && button.visible && button.active) {
          JsonObject value = widgetSummary(button, childIndex);
          value.addProperty("actionIndex", actionIndex++);
          value.addProperty("actionId", "button:" + childIndex);
          actions.add(value);
        }
        childIndex++;
      }
      result.add("actions", actions);
      return result;
    });
  }

  private JsonObject clickAction(String actionId, int requestedIndex) throws Exception {
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      int wantedChild = actionId != null && actionId.startsWith("button:") ? Integer.parseInt(actionId.substring(7)) : -1;
      int childIndex = 0;
      int actionIndex = 0;
      for (var child : client.screen.children()) {
        if (child instanceof AbstractButton button && button.visible && button.active) {
          if ((wantedChild >= 0 && childIndex == wantedChild) || (wantedChild < 0 && actionIndex == requestedIndex)) {
            double x = button.getX() + button.getWidth() / 2.0;
            double y = button.getY() + button.getHeight() / 2.0;
            double scale = client.getWindow().getGuiScale();
            VirtualCursor.set(x * scale, y * scale);
            boolean handled = client.screen.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(0, 0)), false);
            JsonObject result = state();
            JsonObject value = widgetSummary(button, childIndex);
            value.addProperty("actionIndex", actionIndex);
            value.addProperty("actionId", "button:" + childIndex);
            result.add("action", value);
            result.addProperty("handled", handled);
            return result;
          }
          actionIndex++;
        }
        childIndex++;
      }
      throw new IllegalArgumentException("Dialog action not found");
    });
  }

  private JsonObject worldEntities() throws Exception {
    return onClient(() -> {
      if (client.player == null || client.level == null) throw new IllegalStateException("Player is not connected");
      JsonObject result = state();
      JsonArray entities = new JsonArray();
      for (Entity entity : client.level.entitiesForRendering()) {
        if (entity != client.player) entities.add(entitySummary(entity));
      }
      result.add("entities", entities);
      return result;
    });
  }

  private JsonObject interactRole(String role, int requestedIndex, double maxDistance) throws Exception {
    if (requestedIndex < 0 || maxDistance <= 0 || maxDistance > 128) throw new IllegalArgumentException("Invalid entity selector");
    return onClient(() -> {
      if (client.player == null || client.level == null || client.gameMode == null) throw new IllegalStateException("Player is not connected");
      List<Entity> matches = new ArrayList<>();
      for (Entity entity : client.level.entitiesForRendering()) {
        if (entity != client.player && client.player.distanceTo(entity) <= maxDistance && entityMatches(entity, role)) matches.add(entity);
      }
      matches.sort(java.util.Comparator.comparingDouble(client.player::distanceTo));
      if (requestedIndex >= matches.size()) throw new IllegalArgumentException("No visible entity matched role: " + role);
      Entity target = matches.get(requestedIndex);
      var atResult = client.gameMode.interactAt(client.player, target, new EntityHitResult(target), InteractionHand.MAIN_HAND);
      var resultValue = client.gameMode.interact(client.player, target, InteractionHand.MAIN_HAND);
      client.player.swing(InteractionHand.MAIN_HAND);
      JsonObject result = state();
      result.add("entity", entitySummary(target));
      result.addProperty("interacted", true);
      result.addProperty("interactAt", atResult.toString());
      result.addProperty("interact", resultValue.toString());
      return result;
    });
  }

  private JsonObject entitySummary(Entity entity) {
    JsonObject value = new JsonObject();
    value.addProperty("id", entity.getId());
    value.addProperty("uuid", entity.getUUID().toString());
    value.addProperty("type", entity.getType().toString());
    value.addProperty("name", entity.getName().getString());
    value.addProperty("displayName", entity.getDisplayName().getString());
    if (entity.getCustomName() != null) value.addProperty("customName", entity.getCustomName().getString());
    value.addProperty("distance", client.player == null ? -1 : client.player.distanceTo(entity));
    return value;
  }

  private boolean entityMatches(Entity entity, String role) {
    String needle = role.toLowerCase(java.util.Locale.ROOT);
    return entity.getName().getString().toLowerCase(java.util.Locale.ROOT).contains(needle)
      || entity.getDisplayName().getString().toLowerCase(java.util.Locale.ROOT).contains(needle)
      || (entity.getCustomName() != null && entity.getCustomName().getString().toLowerCase(java.util.Locale.ROOT).contains(needle))
      || entity.getType().toString().toLowerCase(java.util.Locale.ROOT).contains(needle)
      || entity.getTags().stream().anyMatch(tag -> tag.toLowerCase(java.util.Locale.ROOT).contains(needle));
  }

  private static JsonObject widgetSummary(AbstractWidget widget, int index) {
    JsonObject value = new JsonObject();
    value.addProperty("index", index);
    value.addProperty("type", widget.getClass().getName());
    value.addProperty("text", widget.getMessage().getString());
    value.addProperty("x", widget.getX());
    value.addProperty("y", widget.getY());
    value.addProperty("width", widget.getWidth());
    value.addProperty("height", widget.getHeight());
    value.addProperty("active", widget.active);
    value.addProperty("visible", widget.visible);
    return value;
  }

  private static boolean textMatches(String actual, String expected, boolean exact) {
    return exact ? actual.equalsIgnoreCase(expected) : actual.toLowerCase(java.util.Locale.ROOT).contains(expected.toLowerCase(java.util.Locale.ROOT));
  }

  private JsonObject typeText(String text) throws Exception {
    if (text.length() > 4096) throw new IllegalArgumentException("text must be at most 4096 characters");
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      int typed = 0;
      int handled = 0;
      for (int offset = 0; offset < text.length();) {
        int codePoint = text.codePointAt(offset);
        if (client.screen.charTyped(new CharacterEvent(codePoint, 0))) handled++;
        typed++;
        offset += Character.charCount(codePoint);
      }
      JsonObject result = state();
      result.addProperty("typedCharacters", typed);
      result.addProperty("handledCharacters", handled);
      return result;
    });
  }

  private JsonObject pressKey(String key, int modifiers) throws Exception {
    int keyCode = keyCode(key);
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      boolean handled = client.screen.keyPressed(new KeyEvent(keyCode, 0, modifiers));
      JsonObject result = state();
      result.addProperty("key", key.toLowerCase());
      result.addProperty("handled", handled);
      return result;
    });
  }

  private JsonObject scroll(double delta) throws Exception {
    if (!Double.isFinite(delta) || delta == 0 || Math.abs(delta) > 100) throw new IllegalArgumentException("delta must be between -100 and 100 and not zero");
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      double scale = client.getWindow().getGuiScale();
      double x = VirtualCursor.active() ? VirtualCursor.x() / scale : client.getWindow().getGuiScaledWidth() / 2.0;
      double y = VirtualCursor.active() ? VirtualCursor.y() / scale : client.getWindow().getGuiScaledHeight() / 2.0;
      boolean handled = client.screen.mouseScrolled(x, y, 0, delta);
      JsonObject result = state();
      result.addProperty("delta", delta);
      result.addProperty("handled", handled);
      return result;
    });
  }

  private JsonObject onClient(ThrowingSupplier action) throws Exception {
    CompletableFuture<JsonObject> future = new CompletableFuture<>();
    client.execute(() -> {
      try { future.complete(action.get()); }
      catch (Throwable error) { future.completeExceptionally(error); }
    });
    return future.get(10, TimeUnit.SECONDS);
  }

  private void respondAuthorized(HttpExchange exchange, ThrowingSupplier action) throws IOException {
    if (!token.equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
      respond(exchange, 401, error("unauthorized"));
      return;
    }
    try { respond(exchange, 200, action.get()); }
    catch (Throwable failure) { respond(exchange, 500, error(failure.getMessage())); }
  }

  private void respond(HttpExchange exchange, int status, JsonObject body) throws IOException {
    byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }

  private static JsonObject ok() { JsonObject value = new JsonObject(); value.addProperty("ok", true); return value; }
  private static JsonObject error(String message) { JsonObject value = new JsonObject(); value.addProperty("ok", false); value.addProperty("error", message == null ? "unknown" : message); return value; }
  private static int queryInt(HttpExchange exchange, String name) { return Integer.parseInt(query(exchange, name)); }
  private static int queryIntDefault(HttpExchange exchange, String name, int fallback) { String value = query(exchange, name); return value == null ? fallback : Integer.parseInt(value); }
  private static double queryDouble(HttpExchange exchange, String name) { return Double.parseDouble(queryRequired(exchange, name)); }
  private static double queryDoubleDefault(HttpExchange exchange, String name, double fallback) { String value = query(exchange, name); return value == null ? fallback : Double.parseDouble(value); }
  private static String queryRequired(HttpExchange exchange, String name) { String value = query(exchange, name); if (value == null) throw new IllegalArgumentException(name + " is required"); return value; }
  private static boolean queryBoolean(HttpExchange exchange, String name) { return Boolean.parseBoolean(query(exchange, name)); }
  private static int keyCode(String key) {
    return switch (key.toLowerCase()) {
      case "enter" -> GLFW.GLFW_KEY_ENTER;
      case "tab" -> GLFW.GLFW_KEY_TAB;
      case "backspace" -> GLFW.GLFW_KEY_BACKSPACE;
      case "delete" -> GLFW.GLFW_KEY_DELETE;
      case "escape", "esc" -> GLFW.GLFW_KEY_ESCAPE;
      case "up" -> GLFW.GLFW_KEY_UP;
      case "down" -> GLFW.GLFW_KEY_DOWN;
      case "left" -> GLFW.GLFW_KEY_LEFT;
      case "right" -> GLFW.GLFW_KEY_RIGHT;
      case "home" -> GLFW.GLFW_KEY_HOME;
      case "end" -> GLFW.GLFW_KEY_END;
      case "page-up" -> GLFW.GLFW_KEY_PAGE_UP;
      case "page-down" -> GLFW.GLFW_KEY_PAGE_DOWN;
      case "space" -> GLFW.GLFW_KEY_SPACE;
      default -> throw new IllegalArgumentException("Unsupported key: " + key);
    };
  }
  private static String query(HttpExchange exchange, String name) {
    String raw = exchange.getRequestURI().getRawQuery();
    if (raw == null) return null;
    for (String part : raw.split("&")) {
      String[] pair = part.split("=", 2);
      if (pair[0].equals(name)) return java.net.URLDecoder.decode(pair.length > 1 ? pair[1] : "", StandardCharsets.UTF_8);
    }
    return null;
  }

  @FunctionalInterface private interface ThrowingRunnable { void run() throws Exception; }
  @FunctionalInterface private interface ThrowingSupplier { JsonObject get() throws Exception; }
}
