package dev.minecraftcli.control.mixin;

import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.network.chat.Style;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(ChatScreen.class)
public interface ChatScreenAccessor {
  @Invoker("handleComponentClicked")
  boolean minecraftCliHandleComponentClicked(Style style, boolean insertionClickMode);
}
