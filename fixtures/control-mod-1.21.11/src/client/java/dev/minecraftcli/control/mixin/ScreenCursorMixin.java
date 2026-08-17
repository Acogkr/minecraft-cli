package dev.minecraftcli.control.mixin;

import dev.minecraftcli.control.VirtualCursor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

@Mixin(Screen.class)
public abstract class ScreenCursorMixin {
  @ModifyVariable(method = "renderWithTooltipAndSubtitles", at = @At("HEAD"), argsOnly = true, ordinal = 0)
  private int minecraftCliMouseX(int value) {
    return VirtualCursor.active() ? (int) (VirtualCursor.x() / Minecraft.getInstance().getWindow().getGuiScale()) : value;
  }

  @ModifyVariable(method = "renderWithTooltipAndSubtitles", at = @At("HEAD"), argsOnly = true, ordinal = 1)
  private int minecraftCliMouseY(int value) {
    return VirtualCursor.active() ? (int) (VirtualCursor.y() / Minecraft.getInstance().getWindow().getGuiScale()) : value;
  }
}
