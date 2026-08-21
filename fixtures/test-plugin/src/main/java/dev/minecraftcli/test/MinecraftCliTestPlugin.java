package dev.minecraftcli.test;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import net.md_5.bungee.api.ChatMessageType;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.chat.ClickEvent;
import net.md_5.bungee.api.chat.HoverEvent;
import net.md_5.bungee.api.chat.hover.content.Text;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Sound;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.BarStyle;
import org.bukkit.boss.BossBar;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Villager;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.Cancellable;
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractAtEntityEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.entity.Entity;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.ShapelessRecipe;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scoreboard.Criteria;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.util.Vector;

public final class MinecraftCliTestPlugin extends JavaPlugin implements CommandExecutor, Listener {
  private static final String ROOT_GUI_TITLE = "Minecraft CLI Slot Test GUI";
  private static final String PAPER_GUI_TITLE = "Minecraft CLI Paper Details";
  private static final String BOOK_GUI_TITLE = "Minecraft CLI Book Details";
  private static final String NPC_NAME = "Minecraft CLI NPC";
  private static final String DIALOG_NPC_NAME = "Minecraft CLI Dialog NPC";
  private static final String HELPER_TARGET_NAME = "Minecraft CLI Helper Target";

  private NamespacedKey npcKey;
  private NamespacedKey dialogNpcKey;
  private NamespacedKey toastRecipeKey;
  private final Map<UUID, String> guiPageByPlayer = new HashMap<>();
  private final Set<UUID> switchingGui = new HashSet<>();

  @Override
  public void onEnable() {
    npcKey = new NamespacedKey(this, "test_npc");
    dialogNpcKey = new NamespacedKey(this, "dialog_test_npc");
    toastRecipeKey = new NamespacedKey(this, "toast_recipe");
    if (Bukkit.getRecipe(toastRecipeKey) == null) {
      Bukkit.addRecipe(new ShapelessRecipe(toastRecipeKey, new ItemStack(Material.PAPER)).addIngredient(Material.STICK));
    }
    getLogger().info("minecraft-cli-test-plugin enabled");
    Objects.requireNonNull(getCommand("mctest")).setExecutor(this);
    Objects.requireNonNull(getCommand("mcnpc")).setExecutor(this);
    Objects.requireNonNull(getCommand("mcdialognpc")).setExecutor(this);
    Objects.requireNonNull(getCommand("mcgui")).setExecutor(this);
    Objects.requireNonNull(getCommand("mchelper")).setExecutor(this);
    getServer().getPluginManager().registerEvents(this, this);
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (command.getName().equalsIgnoreCase("mcnpc")) {
      if (!(sender instanceof Player player)) {
        sender.sendMessage("mcnpc requires a player");
        return true;
      }
      String action = args.length == 0 ? "spawn" : args[0].toLowerCase(Locale.ROOT);
      if (!action.equals("spawn")) {
        sender.sendMessage("usage: /mcnpc spawn");
        return true;
      }
      spawnNpc(player);
      return true;
    }

    if (command.getName().equalsIgnoreCase("mcdialognpc")) {
      if (!(sender instanceof Player player)) {
        sender.sendMessage("mcdialognpc requires a player");
        return true;
      }
      spawnDialogNpc(player);
      return true;
    }

    if (command.getName().equalsIgnoreCase("mcgui")) {
      Player target = args.length > 0 ? Bukkit.getPlayerExact(args[0]) : sender instanceof Player player ? player : null;
      if (target == null) {
        sender.sendMessage("usage: /mcgui [player]");
        return true;
      }
      openSlotTestGui(target);
      if (!target.equals(sender)) {
        sender.sendMessage("minecraft-cli-test-plugin slot gui opened for " + target.getName());
      }
      return true;
    }

    if (command.getName().equalsIgnoreCase("mchelper")) {
      if (!(sender instanceof Player player)) {
        sender.sendMessage("mchelper requires a player");
        return true;
      }
      handleHelperCommand(player, args);
      return true;
    }

    sender.sendMessage("minecraft-cli-test-plugin command ok");
    if (sender instanceof Player player) {
      player.getInventory().addItem(new ItemStack(Material.DIAMOND, 1));
      player.sendMessage("minecraft-cli-test-plugin gave diamond");
    }
    return true;
  }

  private void spawnNpc(Player player) {
    Location location = safeEntityLocation(player, 3.0);
    Villager npc =
        (Villager)
            player
                .getWorld()
                .spawnEntity(location, EntityType.VILLAGER);
    npc.setAI(false);
    npc.setInvulnerable(true);
    npc.setSilent(true);
    npc.setCustomName(NPC_NAME);
    npc.setCustomNameVisible(true);
    npc.getPersistentDataContainer().set(npcKey, PersistentDataType.BYTE, (byte) 1);
    player.sendMessage("minecraft-cli-test-plugin npc spawned " + npc.getEntityId());
  }

  private void spawnDialogNpc(Player player) {
    Location location = safeEntityLocation(player, 3.0);
    Villager npc = (Villager) player.getWorld().spawnEntity(location, EntityType.VILLAGER);
    npc.setAI(false);
    npc.setInvulnerable(true);
    npc.setSilent(true);
    npc.setCustomName(DIALOG_NPC_NAME);
    npc.setCustomNameVisible(true);
    npc.getPersistentDataContainer().set(dialogNpcKey, PersistentDataType.BYTE, (byte) 1);
    player.sendMessage("minecraft-cli-test-plugin dialog npc spawned " + npc.getEntityId());
  }

  private void handleHelperCommand(Player player, String[] args) {
    String action = args.length == 0 ? "help" : args[0].toLowerCase(Locale.ROOT);
    switch (action) {
      case "give" -> {
        Material material = parseMaterial(args.length > 1 ? args[1] : "stone");
        int amount = args.length > 2 ? Math.max(1, Math.min(Integer.parseInt(args[2]), 64)) : 8;
        player.getInventory().addItem(new ItemStack(material, amount));
        player.sendMessage("minecraft-cli-helper gave " + amount + " " + material.name().toLowerCase(Locale.ROOT));
      }
      case "transition" -> {
        String destinationName = player.getWorld().getEnvironment() == org.bukkit.World.Environment.NETHER ? "world" : "world_nether";
        org.bukkit.World destination = Bukkit.getWorld(destinationName);
        if (destination == null) {
          player.sendMessage("minecraft-cli-helper transition world unavailable " + destinationName);
          return;
        }
        player.teleport(destination.getSpawnLocation());
        player.sendMessage("minecraft-cli-helper transition complete " + destination.getEnvironment().name().toLowerCase(Locale.ROOT));
      }
      case "block" -> {
        Material material = parseMaterial(args.length > 1 ? args[1] : "stone");
        Block block = blockInFront(player);
        ensureFloor(block);
        block.setType(material);
        Block floor = block.getRelative(BlockFace.DOWN);
        player.sendMessage(
            "minecraft-cli-helper block "
                + material.name().toLowerCase(Locale.ROOT)
                + " "
                + block.getX()
                + " "
                + block.getY()
                + " "
                + block.getZ()
                + " floor "
                + floor.getX()
                + " "
                + floor.getY()
                + " "
                + floor.getZ());
      }
      case "target" -> {
        Location location = safeEntityLocation(player, 4.5);
        LivingEntity entity = (LivingEntity) player.getWorld().spawnEntity(location, EntityType.PIG);
        entity.setAI(false);
        entity.setCustomName(HELPER_TARGET_NAME);
        entity.setCustomNameVisible(true);
        player.sendMessage("minecraft-cli-helper target pig " + entity.getEntityId());
      }
      case "cleanup" -> {
        int removed = cleanupHelperEntities(player);
        player.sendMessage("minecraft-cli-helper cleanup removed " + removed);
      }
      case "chatdemo" -> {
        Player target = args.length > 1 ? Bukkit.getPlayerExact(args[1]) : player;
        if (target == null) {
          player.sendMessage("usage: /mchelper chatdemo [player]");
          return;
        }
        target.sendMessage("minecraft-cli-helper chat demo line 1");
        target.sendMessage("minecraft-cli-helper chat demo line 2");
        target.sendMessage("minecraft-cli-test-plugin visible chat capture");
        player.sendMessage("minecraft-cli-helper chat demo sent " + target.getName());
      }
      case "interactivechat" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        TextComponent prefix = new TextComponent("Minecraft CLI interactive: ");
        TextComponent actionText = new TextComponent("[Hover and click]");
        actionText.setHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, new Text("Minecraft CLI hover tooltip\nClick opens the GUI")));
        actionText.setClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, "/mcgui"));
        prefix.addExtra(actionText);
        target.spigot().sendMessage(prefix);
        player.sendMessage("minecraft-cli-helper interactive chat sent " + target.getName());
      }
      case "visualgui" -> {
        Player target = args.length > 1 ? Bukkit.getPlayerExact(args[1]) : player;
        if (target == null) {
          player.sendMessage("usage: /mchelper visualgui [player]");
          return;
        }
        prepareVisualTarget(target);
        target.sendMessage("minecraft-cli-test-plugin visual gui opening");
        getServer().getScheduler().runTaskLater(this, () -> openSlotTestGui(target), 20L);
        player.sendMessage("minecraft-cli-helper visual gui scheduled " + target.getName());
      }
      case "airspace" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        target.setGameMode(GameMode.CREATIVE);
        target.setAllowFlight(true);
        target.setFlying(true);
        Location location = target.getLocation().clone().add(0.0, 3.0, 0.0);
        location.setYaw(0.0f);
        location.setPitch(0.0f);
        for (int x = -8; x <= 8; x++) {
          for (int y = -1; y <= 6; y++) {
            for (int z = -8; z <= 8; z++) {
              location.clone().add(x, y, z).getBlock().setType(Material.AIR);
            }
          }
        }
        location.clone().add(0, -1, 0).getBlock().setType(Material.GLASS);
        target.teleport(location);
        player.sendMessage("minecraft-cli-helper airspace ready " + target.getName());
      }
      case "title" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        target.sendTitle("Minecraft CLI Title", "Minecraft CLI Subtitle", 5, 100, 10);
        player.sendMessage("minecraft-cli-helper title sent " + target.getName());
      }
      case "actionbar" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        repeatActionBar(target);
        player.sendMessage("minecraft-cli-helper actionbar sent " + target.getName());
      }
      case "bossbar" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        BossBar bossBar =
            Bukkit.createBossBar("Minecraft CLI Boss Bar", BarColor.GREEN, BarStyle.SOLID);
        bossBar.setProgress(0.75);
        bossBar.addPlayer(target);
        getServer().getScheduler().runTaskLater(this, bossBar::removeAll, 200L);
        player.sendMessage("minecraft-cli-helper bossbar sent " + target.getName());
      }
      case "scoreboard" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        Scoreboard scoreboard =
            Objects.requireNonNull(Bukkit.getScoreboardManager()).getNewScoreboard();
        Objective objective =
            scoreboard.registerNewObjective("mchelper", Criteria.DUMMY, "Minecraft CLI Scoreboard");
        objective.setDisplaySlot(DisplaySlot.SIDEBAR);
        objective.getScore("event").setScore(1);
        objective.getScore("second line").setScore(2);
        target.setScoreboard(scoreboard);
        player.sendMessage("minecraft-cli-helper scoreboard sent " + target.getName());
      }
      case "resetui" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        target.resetTitle();
        target.setScoreboard(Objects.requireNonNull(Bukkit.getScoreboardManager()).getMainScoreboard());
        target.closeInventory();
        player.sendMessage("minecraft-cli-helper ui reset " + target.getName());
      }
      case "sound" -> {
        player.playSound(player.getLocation(), Sound.UI_BUTTON_CLICK, 1.0f, 1.0f);
        player.sendMessage("minecraft-cli-helper sound sent");
      }
      case "toast" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        target.undiscoverRecipe(toastRecipeKey);
        getServer().getScheduler().runTaskLater(this, () -> target.discoverRecipe(toastRecipeKey), 2L);
        player.sendMessage("minecraft-cli-helper toast sent " + target.getName());
      }
      case "signals" -> {
        Player target = helperTarget(player, args);
        if (target == null) return;
        target.sendTitle("Minecraft CLI Title", "Minecraft CLI Subtitle", 5, 40, 5);
        sendHelperActionBar(target);
        BossBar bossBar =
            Bukkit.createBossBar("Minecraft CLI Boss Bar", BarColor.GREEN, BarStyle.SOLID);
        bossBar.setProgress(0.75);
        bossBar.addPlayer(target);
        getServer().getScheduler().runTaskLater(this, bossBar::removeAll, 60L);
        Scoreboard scoreboard =
            Objects.requireNonNull(Bukkit.getScoreboardManager()).getNewScoreboard();
        Objective objective =
            scoreboard.registerNewObjective("mchelper", Criteria.DUMMY, "Minecraft CLI Scoreboard");
        objective.setDisplaySlot(DisplaySlot.SIDEBAR);
        objective.getScore("event").setScore(1);
        target.setScoreboard(scoreboard);
        target.playSound(target.getLocation(), Sound.UI_BUTTON_CLICK, 1.0f, 1.0f);
        player.sendMessage("minecraft-cli-helper signals sent " + target.getName());
      }
      case "setup" -> {
        player.getInventory().addItem(new ItemStack(Material.STONE, 8));
        Block block = blockInFront(player);
        ensureFloor(block);
        block.setType(Material.STONE);
        Block floor = block.getRelative(BlockFace.DOWN);
        Location location = safeEntityLocation(player, 4.5);
        LivingEntity entity = (LivingEntity) player.getWorld().spawnEntity(location, EntityType.PIG);
        entity.setAI(false);
        entity.setCustomName(HELPER_TARGET_NAME);
        entity.setCustomNameVisible(true);
        player.sendMessage(
            "minecraft-cli-helper setup block "
                + block.getX()
                + " "
                + block.getY()
                + " "
                + block.getZ()
                + " floor "
                + floor.getX()
                + " "
                + floor.getY()
                + " "
                + floor.getZ()
                + " target "
                + entity.getEntityId());
      }
      default ->
          player.sendMessage(
              "usage: /mchelper give <material> [amount] | block <material> | target | title [player] | actionbar [player] | bossbar [player] | scoreboard [player] | toast [player] | airspace [player] | sound | signals | setup | cleanup | chatdemo [player] | interactivechat [player] | visualgui [player]");
    }
  }

  private void prepareVisualTarget(Player target) {
    target.leaveVehicle();
    target.setGameMode(GameMode.CREATIVE);
    target.setAllowFlight(true);
    target.setFlying(true);
    target.closeInventory();
    Location spawn = target.getWorld().getSpawnLocation().clone().add(0.5, 4.0, 0.5);
    spawn.setYaw(0.0f);
    spawn.setPitch(0.0f);
    target.teleport(spawn);
  }

  private int cleanupHelperEntities(Player player) {
    int removed = 0;
    for (Entity entity : player.getWorld().getEntities()) {
      if (entity instanceof Player) {
        continue;
      }
      String customName = entity.getCustomName();
      boolean testNpc = customName != null && customName.equals(NPC_NAME);
      boolean dialogNpc = customName != null && customName.equals(DIALOG_NPC_NAME);
      boolean helperTarget = customName != null && customName.equals(HELPER_TARGET_NAME);
      if (!testNpc && entity instanceof Villager villager) {
        Byte marker = villager.getPersistentDataContainer().get(npcKey, PersistentDataType.BYTE);
        testNpc = marker != null && marker == (byte) 1;
      }
      if (testNpc || dialogNpc || helperTarget) {
        entity.remove();
        removed++;
      }
    }
    return removed;
  }

  private void sendHelperActionBar(Player player) {
    player.sendActionBar("Minecraft CLI Action Bar");
    player
        .spigot()
        .sendMessage(ChatMessageType.ACTION_BAR, TextComponent.fromLegacyText("Minecraft CLI Action Bar"));
  }

  private void repeatActionBar(Player player) {
    for (long delay = 0; delay <= 100; delay += 10) {
      getServer().getScheduler().runTaskLater(this, () -> sendHelperActionBar(player), delay);
    }
  }

  private Player helperTarget(Player sender, String[] args) {
    Player target = args.length > 1 ? Bukkit.getPlayerExact(args[1]) : sender;
    if (target == null) sender.sendMessage("minecraft-cli-helper target player not found");
    return target;
  }

  private Material parseMaterial(String raw) {
    Material material = Material.matchMaterial(raw.toUpperCase(Locale.ROOT));
    if (material == null || material.isAir()) {
      return Material.STONE;
    }
    return material;
  }

  private Block blockInFront(Player player) {
    return locationInFront(player, 3.0).getBlock();
  }

  private Location locationInFront(Player player, double distance) {
    Vector direction = player.getLocation().getDirection();
    direction.setY(0);
    if (direction.lengthSquared() < 0.01) {
      direction = new Vector(0, 0, 1);
    }
    Location location = player.getLocation().add(direction.normalize().multiply(distance));
    location.setY(player.getLocation().getBlockY());
    return location;
  }

  private Location safeEntityLocation(Player player, double distance) {
    Location location = locationInFront(player, distance);
    location.setY(player.getLocation().getBlockY());
    Block feet = location.getBlock();
    ensureFloor(feet);
    feet.setType(Material.AIR);
    feet.getRelative(BlockFace.UP).setType(Material.AIR);
    return feet.getLocation().add(0.5, 0.0, 0.5);
  }

  private void ensureFloor(Block block) {
    Block floor = block.getRelative(BlockFace.DOWN);
    floor.setType(Material.GRASS_BLOCK);
  }

  @EventHandler
  public void onPlayerInteractEntity(PlayerInteractEntityEvent event) {
    if (event instanceof PlayerInteractAtEntityEvent) {
      return;
    }
    Player player = event.getPlayer();
    event
        .getPlayer()
        .sendMessage(
            "minecraft-cli-helper entity-interact "
                + event.getRightClicked().getType().name().toLowerCase(Locale.ROOT)
                + " "
                + event.getRightClicked().getEntityId());

    handleNpcInteraction(player, event.getRightClicked(), event);
  }

  @EventHandler
  public void onPlayerInteractAtEntity(PlayerInteractAtEntityEvent event) {
    Player player = event.getPlayer();
    player.sendMessage(
        "minecraft-cli-helper entity-interact-at "
            + event.getRightClicked().getType().name().toLowerCase(Locale.ROOT)
            + " "
            + event.getRightClicked().getEntityId());
    handleNpcInteraction(player, event.getRightClicked(), event);
  }

  private void handleNpcInteraction(Player player, Entity entity, Cancellable event) {
    if (!(entity instanceof Villager villager)) {
      return;
    }
    Byte marker = villager.getPersistentDataContainer().get(npcKey, PersistentDataType.BYTE);
    Byte dialogMarker = villager.getPersistentDataContainer().get(dialogNpcKey, PersistentDataType.BYTE);
    if (dialogMarker != null && dialogMarker == (byte) 1) {
      event.setCancelled(true);
      player.sendMessage("minecraft-cli-test-plugin dialog npc clicked");
      boolean shown = Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "dialog show " + player.getName() + " minecraft:server_links");
      player.sendMessage("minecraft-cli-test-plugin dialog dispatched " + shown);
      return;
    }
    if (marker == null || marker != (byte) 1) {
      return;
    }

    event.setCancelled(true);
    player.sendMessage("minecraft-cli-test-plugin npc clicked");
    Inventory gui = getServer().createInventory(null, 9, "Minecraft CLI NPC GUI");
    gui.setItem(3, new ItemStack(Material.EMERALD, 1));
    gui.setItem(5, new ItemStack(Material.DIAMOND, 1));
    player.openInventory(gui);
  }

  private void openSlotTestGui(Player player) {
    Inventory gui = getServer().createInventory(null, 27, ROOT_GUI_TITLE);
    gui.setItem(10, namedItem(Material.PAPER, "Paper Menu", List.of("slot 10", "click to open paper details")));
    gui.setItem(20, namedItem(Material.BOOK, "Book Menu", List.of("slot 20", "click to open book details")));
    player.sendMessage("minecraft-cli-test-plugin slot gui opened");
    openTrackedGui(player, gui, "root");
  }

  private void openPaperDetailsGui(Player player) {
    Inventory gui = getServer().createInventory(null, 27, PAPER_GUI_TITLE);
    gui.setItem(13, namedItem(Material.PAPER, "Paper Detail Item", List.of("paper detail lore line 1", "paper detail lore line 2")));
    gui.setItem(22, namedItem(Material.ARROW, "Back", List.of("close with ESC to return")));
    player.sendMessage("minecraft-cli-test-plugin paper details opened");
    openTrackedGui(player, gui, "paper");
  }

  private void openBookDetailsGui(Player player) {
    Inventory gui = getServer().createInventory(null, 27, BOOK_GUI_TITLE);
    gui.setItem(13, namedItem(Material.BOOK, "Book Detail Item", List.of("book detail lore line 1", "book detail lore line 2")));
    gui.setItem(22, namedItem(Material.ARROW, "Back", List.of("close with ESC to return")));
    player.sendMessage("minecraft-cli-test-plugin book details opened");
    openTrackedGui(player, gui, "book");
  }

  private void openTrackedGui(Player player, Inventory gui, String page) {
    UUID id = player.getUniqueId();
    switchingGui.add(id);
    player.openInventory(gui);
    guiPageByPlayer.put(id, page);
    getServer().getScheduler().runTask(this, () -> switchingGui.remove(id));
  }

  private ItemStack namedItem(Material material, String name, List<String> lore) {
    ItemStack item = new ItemStack(material, 1);
    ItemMeta meta = item.getItemMeta();
    if (meta != null) {
      meta.setDisplayName(name);
      meta.setLore(lore);
      item.setItemMeta(meta);
    }
    return item;
  }

  @EventHandler
  public void onInventoryClick(InventoryClickEvent event) {
    if (!(event.getWhoClicked() instanceof Player player)) {
      return;
    }
    String title = event.getView().getTitle();
    if (!title.equals(ROOT_GUI_TITLE) && !title.equals(PAPER_GUI_TITLE) && !title.equals(BOOK_GUI_TITLE)) {
      return;
    }

    event.setCancelled(true);
    int slot = event.getRawSlot();
    if (title.equals(ROOT_GUI_TITLE) && slot == 10) {
      openPaperDetailsGui(player);
    } else if (title.equals(ROOT_GUI_TITLE) && slot == 20) {
      openBookDetailsGui(player);
    } else if ((title.equals(PAPER_GUI_TITLE) || title.equals(BOOK_GUI_TITLE)) && slot == 22) {
      openSlotTestGui(player);
    }
  }

  @EventHandler
  public void onInventoryClose(InventoryCloseEvent event) {
    if (!(event.getPlayer() instanceof Player player)) {
      return;
    }
    UUID id = player.getUniqueId();
    if (switchingGui.contains(id)) {
      return;
    }

    String page = guiPageByPlayer.remove(id);
    if (page == null || page.equals("root")) {
      return;
    }
    getServer().getScheduler().runTask(this, () -> openSlotTestGui(player));
  }

  @EventHandler
  public void onPlayerInteract(PlayerInteractEvent event) {
    if (event.getHand() != EquipmentSlot.HAND) {
      return;
    }
    Player player = event.getPlayer();
    Action action = event.getAction();
    Block block = event.getClickedBlock();
    ItemStack item = event.getItem();
    if (block != null) {
      player.sendMessage(
          "minecraft-cli-helper interact-block "
              + action.name().toLowerCase(Locale.ROOT)
              + " "
              + block.getType().name().toLowerCase(Locale.ROOT)
              + " "
              + block.getX()
              + " "
              + block.getY()
              + " "
              + block.getZ()
              + " item "
              + (item == null ? "none" : item.getType().name().toLowerCase(Locale.ROOT)));
    } else if (item != null) {
      player.sendMessage(
          "minecraft-cli-helper interact-item "
              + action.name().toLowerCase(Locale.ROOT)
              + " "
              + item.getType().name().toLowerCase(Locale.ROOT));
    }
  }

  @EventHandler
  public void onBlockPlace(BlockPlaceEvent event) {
    Block block = event.getBlockPlaced();
    event
        .getPlayer()
        .sendMessage(
            "minecraft-cli-helper block-place "
                + block.getType().name().toLowerCase(Locale.ROOT)
                + " "
                + block.getX()
                + " "
                + block.getY()
                + " "
                + block.getZ());
  }

  @EventHandler
  public void onBlockBreak(BlockBreakEvent event) {
    Block block = event.getBlock();
    event
        .getPlayer()
        .sendMessage(
            "minecraft-cli-helper block-break "
                + block.getType().name().toLowerCase(Locale.ROOT)
                + " "
                + block.getX()
                + " "
                + block.getY()
                + " "
                + block.getZ());
  }

  @EventHandler
  public void onEntityDamageByEntity(EntityDamageByEntityEvent event) {
    if (event.getDamager() instanceof Player player) {
      player.sendMessage(
          "minecraft-cli-helper entity-damage "
              + event.getEntity().getType().name().toLowerCase(Locale.ROOT)
              + " "
              + event.getEntity().getEntityId());
    }
  }

  @EventHandler
  public void onPlayerDropItem(PlayerDropItemEvent event) {
    ItemStack item = event.getItemDrop().getItemStack();
    event
        .getPlayer()
        .sendMessage(
            "minecraft-cli-helper item-drop "
                + item.getType().name().toLowerCase(Locale.ROOT)
                + " "
                + item.getAmount());
  }

  @EventHandler
  public void onPlayerAnimation(PlayerAnimationEvent event) {
    event.getPlayer().sendMessage("minecraft-cli-helper arm-swing");
  }
}
