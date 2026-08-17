package dev.minecraftcli.control.mixin;

import dev.minecraftcli.control.VirtualCursor;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {
  @Inject(method = "xpos", at = @At("HEAD"), cancellable = true)
  private void minecraftCliX(CallbackInfoReturnable<Double> result) {
    if (VirtualCursor.active()) result.setReturnValue(VirtualCursor.x());
  }

  @Inject(method = "ypos", at = @At("HEAD"), cancellable = true)
  private void minecraftCliY(CallbackInfoReturnable<Double> result) {
    if (VirtualCursor.active()) result.setReturnValue(VirtualCursor.y());
  }
}
