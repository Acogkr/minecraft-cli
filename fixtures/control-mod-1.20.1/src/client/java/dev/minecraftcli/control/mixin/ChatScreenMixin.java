package dev.minecraftcli.control.mixin;

import dev.minecraftcli.control.VirtualCursor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

@Mixin(ChatScreen.class)
public abstract class ChatScreenMixin {
  @ModifyVariable(method = "render", at = @At("HEAD"), argsOnly = true, ordinal = 0)
  private int minecraftCliMouseX(int value) {
    return VirtualCursor.active() ? (int) (VirtualCursor.x() / Minecraft.getInstance().getWindow().getGuiScale()) : value;
  }

  @ModifyVariable(method = "render", at = @At("HEAD"), argsOnly = true, ordinal = 1)
  private int minecraftCliMouseY(int value) {
    return VirtualCursor.active() ? (int) (VirtualCursor.y() / Minecraft.getInstance().getWindow().getGuiScale()) : value;
  }
}
