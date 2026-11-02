package com.demo;

public class OrderService {
    public void create(Order order) {
        if (order.getQty() <= 0) {
            throw new IllegalArgumentException("qty must be positive");
        }
        inventory.check(order);
    }
}
