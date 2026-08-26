package dev.minecraftcli.control.mixin;

import net.minecraft.client.gui.components.ScrollableLayout;
import net.minecraft.client.gui.layouts.Layout;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ScrollableLayout.class)
public interface ScrollableLayoutAccessor {
  @Accessor("content")
  Layout minecraftCli$getContent();
}
