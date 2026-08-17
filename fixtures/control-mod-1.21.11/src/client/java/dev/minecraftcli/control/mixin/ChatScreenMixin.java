package dev.minecraftcli.control.mixin;

import dev.minecraftcli.control.VirtualCursor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.ActiveTextCollector;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.ChatScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

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

  @Inject(method = "render", at = @At("TAIL"))
  private void minecraftCliRenderHover(GuiGraphics graphics, int mouseX, int mouseY, float partialTick, CallbackInfo callback) {
    if (!VirtualCursor.active()) return;
    Minecraft client = Minecraft.getInstance();
    var finder = new ActiveTextCollector.ClickableStyleFinder(client.font, mouseX, mouseY).includeInsertions(true);
    client.gui.getChat().captureClickableText(finder, client.getWindow().getGuiScaledHeight(), client.gui.getGuiTicks(), true);
    var style = finder.result();
    if (style != null && style.getHoverEvent() != null) graphics.renderComponentHoverEffect(client.font, style, mouseX, mouseY);
  }
}
