package dev.minecraftcli.probe;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.papermc.paper.event.player.AsyncChatEvent;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.command.PluginCommand;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.event.server.PluginDisableEvent;
import org.bukkit.event.server.PluginEnableEvent;
import com.destroystokyo.paper.event.server.ServerExceptionEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.potion.PotionEffect;

public final class MinecraftCliPaperProbe extends JavaPlugin implements Listener {
  private static final Gson GSON = new Gson();
  private static final int MAX_EVENTS = 5000;
  private final AtomicLong sequence = new AtomicLong();
  private final ConcurrentLinkedDeque<Map<String, Object>> events = new ConcurrentLinkedDeque<>();
  private final Map<UUID, String> correlations = new ConcurrentHashMap<>();
  private final Map<UUID, Map<String, Boolean>> probePermissions = new ConcurrentHashMap<>();
  private final Map<UUID, PermissionAttachment> permissionAttachments = new ConcurrentHashMap<>();
  private final Map<String, PlayerSnapshot> snapshots = new ConcurrentHashMap<>();
  private HttpServer server;
  private String token;
  private Path runtimeFile;

  @Override
  public void onEnable() {
    Bukkit.getPluginManager().registerEvents(this, this);
    try {
      token = randomToken();
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.createContext("/health", exchange -> authorized(exchange, () -> health()));
      server.createContext("/events", exchange -> authorized(exchange, () -> eventResponse(exchange)));
      server.createContext("/correlation", exchange -> authorized(exchange, () -> correlation(exchange)));
      server.createContext("/command", exchange -> authorized(exchange, () -> command(exchange)));
      server.createContext("/snapshot", exchange -> authorized(exchange, () -> snapshot(exchange)));
      server.createContext("/restore", exchange -> authorized(exchange, () -> restore(exchange)));
      server.createContext("/permissions", exchange -> authorized(exchange, () -> permissions(exchange)));
      server.createContext("/diagnostics", exchange -> authorized(exchange, () -> diagnostics()));
      server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "minecraft-cli-paper-probe-http");
        thread.setDaemon(true);
        return thread;
      }));
      server.start();
      writeRuntimeFile(server.getAddress().getPort());
    } catch (Exception error) {
      getLogger().severe("Could not start localhost probe: " + error.getMessage());
      Bukkit.getPluginManager().disablePlugin(this);
    }
  }

  @Override
  public void onDisable() {
    if (server != null) server.stop(0);
    for (PermissionAttachment attachment : permissionAttachments.values()) {
      try { attachment.remove(); } catch (Exception ignored) {}
    }
    permissionAttachments.clear();
    try {
      if (runtimeFile != null && Files.exists(runtimeFile)) {
        JsonObject current = GSON.fromJson(Files.readString(runtimeFile), JsonObject.class);
        if (current != null && current.has("token") && token.equals(current.get("token").getAsString())) Files.deleteIfExists(runtimeFile);
      }
    } catch (Exception ignored) {}
  }

  private Map<String, Object> health() {
    return Map.of("ok", true, "name", getName(), "version", getPluginMeta().getVersion(), "serverVersion", Bukkit.getMinecraftVersion(), "nextSequence", sequence.get());
  }

  private Map<String, Object> eventResponse(HttpExchange exchange) {
    Map<String, String> query = query(exchange);
    long after = parseLong(query.get("after"), 0);
    int limit = (int) Math.max(1, Math.min(parseLong(query.get("limit"), 100), 500));
    String correlation = query.get("correlation");
    List<Map<String, Object>> selected = events.stream()
      .filter(event -> ((Number) event.get("sequence")).longValue() > after)
      .filter(event -> correlation == null || correlation.equals(event.get("correlationId")))
      .limit(limit)
      .toList();
    return Map.of("ok", true, "available", true, "afterSequence", after, "nextSequence", sequence.get(), "count", selected.size(), "events", selected);
  }

  private Map<String, Object> correlation(HttpExchange exchange) {
    requirePost(exchange);
    JsonObject body = body(exchange);
    UUID playerId = uuid(body, "playerUuid");
    String scenarioId = text(body, "scenarioId", 120);
    if (scenarioId.isBlank()) correlations.remove(playerId); else correlations.put(playerId, scenarioId);
    return Map.of("ok", true, "playerUuid", playerId.toString(), "scenarioId", scenarioId);
  }

  private Map<String, Object> command(HttpExchange exchange) throws Exception {
    requirePost(exchange);
    JsonObject body = body(exchange);
    UUID playerId = uuid(body, "playerUuid");
    String command = text(body, "command", 2048).replaceFirst("^/+", "");
    String permission = body.has("permission") ? text(body, "permission", 256) : "";
    return onMain(() -> {
      Player player = requirePlayer(playerId);
      boolean permissionAllowed = permission.isBlank() || player.hasPermission(permission);
      boolean dispatched = permissionAllowed && Bukkit.dispatchCommand(player, command);
      Map<String, Object> data = linked("command", command, "permission", permission, "permissionAllowed", permissionAllowed, "dispatched", dispatched);
      observe("command_dispatch_result", player, data);
      return linked("ok", true, "playerUuid", playerId.toString(), "permissionAllowed", permissionAllowed, "dispatched", dispatched);
    });
  }

  private Map<String, Object> snapshot(HttpExchange exchange) throws Exception {
    requirePost(exchange);
    UUID playerId = uuid(body(exchange), "playerUuid");
    return onMain(() -> {
      Player player = requirePlayer(playerId);
      String id = UUID.randomUUID().toString();
      snapshots.put(id, PlayerSnapshot.capture(player, probePermissions.getOrDefault(playerId, Map.of())));
      return linked("ok", true, "snapshotId", id, "playerUuid", playerId.toString(), "state", playerState(player));
    });
  }

  private Map<String, Object> restore(HttpExchange exchange) throws Exception {
    requirePost(exchange);
    JsonObject body = body(exchange);
    String snapshotId = text(body, "snapshotId", 80);
    PlayerSnapshot snapshot = snapshots.remove(snapshotId);
    if (snapshot == null) throw new IllegalArgumentException("snapshot not found");
    return onMain(() -> {
      Player player = requirePlayer(snapshot.playerId());
      snapshot.restore(player);
      applyProbePermissions(player, snapshot.permissions());
      observe("state_restored", player, Map.of("snapshotId", snapshotId));
      return linked("ok", true, "snapshotId", snapshotId, "playerUuid", player.getUniqueId().toString(), "state", playerState(player));
    });
  }

  private Map<String, Object> permissions(HttpExchange exchange) throws Exception {
    requirePost(exchange);
    JsonObject body = body(exchange);
    UUID playerId = uuid(body, "playerUuid");
    Map<String, Boolean> values = new LinkedHashMap<>();
    if (body.has("permissions") && body.get("permissions").isJsonObject()) {
      for (var entry : body.getAsJsonObject("permissions").entrySet()) values.put(entry.getKey(), entry.getValue().getAsBoolean());
    }
    return onMain(() -> {
      Player player = requirePlayer(playerId);
      applyProbePermissions(player, values);
      return linked("ok", true, "playerUuid", playerId.toString(), "permissions", values);
    });
  }

  private Map<String, Object> diagnostics() throws Exception {
    return onMain(() -> linked(
      "ok", true,
      "available", true,
      "onlinePlayers", Bukkit.getOnlinePlayers().size(),
      "tps", Arrays.stream(Bukkit.getTPS()).boxed().toList(),
      "mspt", Bukkit.getAverageTickTime(),
      "nextSequence", sequence.get()
    ));
  }

  private void applyProbePermissions(Player player, Map<String, Boolean> values) {
    PermissionAttachment old = permissionAttachments.remove(player.getUniqueId());
    if (old != null) old.remove();
    probePermissions.put(player.getUniqueId(), Map.copyOf(values));
    if (values.isEmpty()) return;
    PermissionAttachment attachment = player.addAttachment(this);
    values.forEach(attachment::setPermission);
    permissionAttachments.put(player.getUniqueId(), attachment);
    player.recalculatePermissions();
  }

  private void observe(String type, Player player, Map<String, Object> data) {
    long next = sequence.incrementAndGet();
    Map<String, Object> event = linked("sequence", next, "timestamp", Instant.now().toString(), "type", type);
    if (player != null) {
      event.put("playerUuid", player.getUniqueId().toString());
      event.put("playerName", player.getName());
      String correlation = correlations.get(player.getUniqueId());
      if (correlation != null) event.put("correlationId", correlation);
    }
    event.put("data", data);
    events.addLast(event);
    while (events.size() > MAX_EVENTS) events.pollFirst();
  }

  @EventHandler(priority = EventPriority.MONITOR) public void onJoin(PlayerJoinEvent event) { observe("player_join", event.getPlayer(), playerState(event.getPlayer())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onQuit(PlayerQuitEvent event) { observe("player_quit", event.getPlayer(), playerState(event.getPlayer())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onWorld(PlayerChangedWorldEvent event) { observe("player_changed_world", event.getPlayer(), linked("from", event.getFrom().getName(), "to", event.getPlayer().getWorld().getName(), "position", location(event.getPlayer().getLocation()))); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onCommand(PlayerCommandPreprocessEvent event) {
    String raw = event.getMessage().replaceFirst("^/+", "");
    String label = raw.split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
    PluginCommand command = Bukkit.getPluginCommand(label);
    String permission = command == null || command.getPermission() == null ? "" : command.getPermission();
    observe("command_preprocess", event.getPlayer(), linked("command", raw, "cancelled", event.isCancelled(), "permission", permission, "permissionAllowed", permission.isBlank() || event.getPlayer().hasPermission(permission)));
  }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onOpen(InventoryOpenEvent event) { if (event.getPlayer() instanceof Player player) observe("inventory_open", player, linked("viewType", event.getView().getType().name(), "title", event.getView().getTitle(), "cancelled", event.isCancelled())); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onClick(InventoryClickEvent event) { if (event.getWhoClicked() instanceof Player player) observe("inventory_click", player, linked("viewType", event.getView().getType().name(), "title", event.getView().getTitle(), "rawSlot", event.getRawSlot(), "click", event.getClick().name(), "action", event.getAction().name(), "cancelled", event.isCancelled())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onClose(InventoryCloseEvent event) { if (event.getPlayer() instanceof Player player) observe("inventory_close", player, linked("viewType", event.getView().getType().name(), "title", event.getView().getTitle())); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onChat(AsyncChatEvent event) { observe("async_chat", event.getPlayer(), linked("cancelled", event.isCancelled(), "message", PlainTextComponentSerializer.plainText().serialize(event.message()))); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onInteract(PlayerInteractEvent event) { observe("player_interact", event.getPlayer(), linked("action", event.getAction().name(), "block", event.getClickedBlock() == null ? null : event.getClickedBlock().getType().name(), "item", event.getItem() == null ? null : event.getItem().getType().name(), "cancelled", event.isCancelled())); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onInteractEntity(PlayerInteractEntityEvent event) { Entity target = event.getRightClicked(); observe("player_interact_entity", event.getPlayer(), linked("targetType", target.getType().name(), "targetUuid", target.getUniqueId().toString(), "cancelled", event.isCancelled())); }
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void onTeleport(PlayerTeleportEvent event) { observe("player_teleport", event.getPlayer(), linked("cause", event.getCause().name(), "from", location(event.getFrom()), "to", location(event.getTo()), "cancelled", event.isCancelled())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onRespawn(PlayerRespawnEvent event) { observe("player_respawn", event.getPlayer(), linked("world", event.getRespawnLocation().getWorld().getName(), "position", location(event.getRespawnLocation()))); }
  @EventHandler(priority = EventPriority.MONITOR) public void onDeath(PlayerDeathEvent event) { observe("player_death", event.getEntity(), linked("world", event.getEntity().getWorld().getName(), "position", location(event.getEntity().getLocation()), "message", event.deathMessage() == null ? "" : PlainTextComponentSerializer.plainText().serialize(event.deathMessage()))); }
  @EventHandler(priority = EventPriority.MONITOR) public void onPluginEnable(PluginEnableEvent event) { observe("plugin_enable", null, linked("plugin", event.getPlugin().getName(), "version", event.getPlugin().getPluginMeta().getVersion())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onPluginDisable(PluginDisableEvent event) { observe("plugin_disable", null, linked("plugin", event.getPlugin().getName(), "version", event.getPlugin().getPluginMeta().getVersion())); }
  @EventHandler(priority = EventPriority.MONITOR) public void onServerException(ServerExceptionEvent event) { observe("uncaught_exception", null, linked("message", event.getException().getMessage(), "type", event.getException().getClass().getName())); }

  private Player requirePlayer(UUID id) {
    Player player = Bukkit.getPlayer(id);
    if (player == null) throw new IllegalArgumentException("player is not online");
    return player;
  }

  private Map<String, Object> playerState(Player player) {
    return linked("world", player.getWorld().getName(), "position", location(player.getLocation()), "gameMode", player.getGameMode().name(), "health", player.getHealth(), "inventory", itemSummary(player.getInventory().getContents()));
  }

  private List<Map<String, Object>> itemSummary(ItemStack[] contents) {
    List<Map<String, Object>> result = new ArrayList<>();
    for (int slot = 0; slot < contents.length; slot++) {
      ItemStack item = contents[slot];
      if (item != null && item.getType() != Material.AIR) result.add(linked("slot", slot, "type", item.getType().name(), "amount", item.getAmount()));
    }
    return result;
  }

  private Map<String, Object> location(Location location) {
    if (location == null || location.getWorld() == null) return Map.of();
    return linked("world", location.getWorld().getName(), "x", location.getX(), "y", location.getY(), "z", location.getZ(), "yaw", location.getYaw(), "pitch", location.getPitch());
  }

  private <T> T onMain(java.util.concurrent.Callable<T> action) throws Exception {
    if (Bukkit.isPrimaryThread()) return action.call();
    CompletableFuture<T> future = new CompletableFuture<>();
    Bukkit.getScheduler().runTask(this, () -> {
      try { future.complete(action.call()); } catch (Throwable error) { future.completeExceptionally(error); }
    });
    return future.get(10, TimeUnit.SECONDS);
  }

  private void writeRuntimeFile(int port) throws IOException {
    String workspace = System.getenv("MINECRAFT_CLI_WORKSPACE");
    if (workspace == null || workspace.isBlank()) {
      getLogger().warning("MINECRAFT_CLI_WORKSPACE is not set; probe is running but not discoverable by minecraft-cli.");
      return;
    }
    runtimeFile = Path.of(workspace).toAbsolutePath().normalize().resolve(".minecraft-cli").resolve("runtime").resolve("probe.json");
    Files.createDirectories(runtimeFile.getParent());
    Files.writeString(runtimeFile, GSON.toJson(linked("port", port, "token", token, "plugin", getName(), "serverRoot", getServer().getWorldContainer().toPath().toAbsolutePath().normalize().toString(), "startedAt", Instant.now().toString())));
  }

  private String randomToken() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    return java.util.HexFormat.of().formatHex(bytes);
  }

  private void authorized(HttpExchange exchange, ThrowingSupplier supplier) throws IOException {
    if (!token.equals(exchange.getRequestHeaders().getFirst("Authorization"))) { respond(exchange, 401, Map.of("ok", false, "error", "unauthorized")); return; }
    try { respond(exchange, 200, supplier.get()); }
    catch (Throwable error) { respond(exchange, 400, linked("ok", false, "error", error.getMessage(), "type", error.getClass().getSimpleName())); }
  }

  private void respond(HttpExchange exchange, int status, Object value) throws IOException {
    byte[] bytes = GSON.toJson(value).getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, bytes.length);
    try (var body = exchange.getResponseBody()) { body.write(bytes); }
  }

  private JsonObject body(HttpExchange exchange) {
    try { return GSON.fromJson(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8), JsonObject.class); }
    catch (IOException error) { throw new IllegalArgumentException("invalid JSON body", error); }
  }
  private void requirePost(HttpExchange exchange) { if (!"POST".equals(exchange.getRequestMethod())) throw new IllegalArgumentException("POST required"); }
  private UUID uuid(JsonObject body, String key) { return UUID.fromString(text(body, key, 80)); }
  private String text(JsonObject body, String key, int max) { if (!body.has(key)) throw new IllegalArgumentException(key + " is required"); String value = body.get(key).getAsString(); if (value.length() > max) throw new IllegalArgumentException(key + " is too long"); return value; }
  private long parseLong(String value, long fallback) { try { return value == null ? fallback : Long.parseLong(value); } catch (NumberFormatException ignored) { return fallback; } }
  private Map<String, String> query(HttpExchange exchange) {
    Map<String, String> values = new LinkedHashMap<>();
    String raw = exchange.getRequestURI().getRawQuery();
    if (raw == null) return values;
    for (String pair : raw.split("&")) { String[] parts = pair.split("=", 2); values.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8), parts.length > 1 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : ""); }
    return values;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> linked(Object... pairs) {
    Map<String, Object> result = new LinkedHashMap<>();
    for (int index = 0; index + 1 < pairs.length; index += 2) result.put(String.valueOf(pairs[index]), pairs[index + 1]);
    return result;
  }

  @FunctionalInterface private interface ThrowingSupplier { Object get() throws Exception; }

  private record PlayerSnapshot(UUID playerId, Location location, GameMode gameMode, ItemStack[] inventory, List<PotionEffect> effects, Map<String, Boolean> permissions) {
    static PlayerSnapshot capture(Player player, Map<String, Boolean> permissions) {
      ItemStack[] contents = Arrays.stream(player.getInventory().getContents()).map(item -> item == null ? null : item.clone()).toArray(ItemStack[]::new);
      return new PlayerSnapshot(player.getUniqueId(), player.getLocation().clone(), player.getGameMode(), contents, new ArrayList<>(player.getActivePotionEffects()), Map.copyOf(permissions));
    }
    void restore(Player player) {
      player.teleport(location);
      player.setGameMode(gameMode);
      player.getInventory().setContents(Arrays.stream(inventory).map(item -> item == null ? null : item.clone()).toArray(ItemStack[]::new));
      for (PotionEffect effect : new ArrayList<>(player.getActivePotionEffects())) player.removePotionEffect(effect.getType());
      player.addPotionEffects(effects);
    }
  }
}
