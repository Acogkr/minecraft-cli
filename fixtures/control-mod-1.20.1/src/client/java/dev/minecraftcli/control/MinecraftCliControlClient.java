package dev.minecraftcli.control;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.world.inventory.ClickType;
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
        CompletableFuture.delayedExecutor(5, TimeUnit.SECONDS).execute(() -> client.execute(() -> {
          String address = host + ":" + serverPort;
          ServerData data = new ServerData("minecraft-cli", address, false);
          ConnectScreen.startConnecting(client.screen, client, new ServerAddress(host, serverPort), data, false);
        }));
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
    result.addProperty("version", "1.20.1");
    result.addProperty("screen", client.screen == null ? "game" : client.screen.getClass().getName());
    result.addProperty("connected", client.getConnection() != null);
    result.addProperty("guiWidth", client.getWindow().getGuiScaledWidth());
    result.addProperty("guiHeight", client.getWindow().getGuiScaledHeight());
    if (client.player != null) result.addProperty("player", client.player.getGameProfile().getName());
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
      client.setScreen(new ChatScreen(""));
    });
  }

  private JsonObject screenshot(HttpExchange exchange) throws Exception {
    String rawPath = query(exchange, "path");
    if (rawPath == null || rawPath.isBlank()) throw new IllegalArgumentException("path is required");
    Path output = Path.of(rawPath).toAbsolutePath().normalize();
    Files.createDirectories(output.getParent());
    return onClient(() -> {
      Path generated = output.getParent().resolve("screenshots").resolve(output.getFileName());
      Screenshot.grab(output.getParent().toFile(), output.getFileName().toString(), client.getMainRenderTarget(), component -> {});
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
      double guiX = -1;
      double guiY = -1;
      net.minecraft.network.chat.Style found = null;
      for (int y = guiHeight - 20; y >= Math.max(0, guiHeight - 180) && found == null; y--) {
        for (int x = 0; x < Math.min(guiWidth, 500); x++) {
          var style = client.gui.getChat().getClickedComponentStyleAt(x, y);
          if (style != null && (style.getHoverEvent() != null || style.getClickEvent() != null)) {
            guiX = x;
            guiY = y;
            found = style;
            break;
          }
        }
      }
      if (found == null) throw new IllegalStateException("No interactive chat component is visible");
      double scale = client.getWindow().getGuiScale();
      VirtualCursor.set(guiX * scale, guiY * scale);
      JsonObject result = ok();
      result.addProperty("line", line);
      result.addProperty("x", guiX);
      result.addProperty("y", guiY);
      if (found.getHoverEvent() != null) result.addProperty("hoverAction", found.getHoverEvent().getAction().toString());
      if (found.getClickEvent() != null) result.addProperty("clickAction", found.getClickEvent().getAction().toString());
      return result;
    });
  }

  private JsonObject clickVirtual() throws Exception {
    return onClient(() -> {
      if (client.screen == null || !VirtualCursor.active()) throw new IllegalStateException("No screen or virtual cursor");
      double scale = client.getWindow().getGuiScale();
      boolean handled = client.screen.mouseClicked(VirtualCursor.x() / scale, VirtualCursor.y() / scale, 0);
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
      boolean handled = client.screen.mouseClicked(x, y, button);
      JsonObject result = state();
      result.addProperty("x", x);
      result.addProperty("y", y);
      result.addProperty("button", button);
      result.addProperty("handled", handled);
      return result;
    });
  }

  private JsonObject typeText(String text) throws Exception {
    if (text.length() > 4096) throw new IllegalArgumentException("text must be at most 4096 characters");
    return onClient(() -> {
      if (client.screen == null) throw new IllegalStateException("No screen is open");
      int typed = 0;
      int handled = 0;
      for (int offset = 0; offset < text.length();) {
        int codePoint = text.codePointAt(offset);
        if (!Character.isBmpCodePoint(codePoint)) throw new IllegalArgumentException("This Minecraft version supports BMP text input only");
        if (client.screen.charTyped((char) codePoint, 0)) handled++;
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
      boolean handled = client.screen.keyPressed(keyCode, 0, modifiers);
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
      boolean handled = client.screen.mouseScrolled(x, y, delta);
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
  private static String queryRequired(HttpExchange exchange, String name) { String value = query(exchange, name); if (value == null) throw new IllegalArgumentException(name + " is required"); return value; }
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
