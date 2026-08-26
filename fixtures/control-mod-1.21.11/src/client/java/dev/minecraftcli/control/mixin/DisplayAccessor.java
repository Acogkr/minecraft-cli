package dev.minecraftcli.control.mixin;

import net.minecraft.world.entity.Display;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Display.class)
public interface DisplayAccessor {
  @Invoker("getViewRange")
  float minecraftCli$getViewRange();
}
